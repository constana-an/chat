import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../server/index.js';
import { formatClock } from '../server/notifications.js';

/** Boot a throwaway server (no persistence) and return a small client. */
const PASSWORD = 'correct-horse-battery';

async function withServer(run, { seedDemo = false } = {}) {
  const { server, store } = createApp({ dataFile: null, seedDemo });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (token, method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json().catch(() => ({}));
    return { status: res.status, ...payload };
  };

  const signIn = async (username, password = PASSWORD) => {
    const { token, user } = await call(null, 'POST', '/api/session', { username, password });
    return { token, user, call: (method, path, body) => call(token, method, path, body) };
  };

  /** Read the server-sent-event stream into an array we can assert against. */
  const openStream = async (token) => {
    const controller = new AbortController();
    const res = await fetch(base + '/api/events', {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const events = [];
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();

    (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let split;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            let type = 'message';
            const lines = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) type = line.slice(7).trim();
              else if (line.startsWith('data: ')) lines.push(line.slice(6));
            }
            if (lines.length) events.push({ type, data: JSON.parse(lines.join('\n')) });
          }
        }
      } catch { /* aborted */ }
    })();

    return { events, close: () => controller.abort() };
  };

  try {
    await run({ base, signIn, call, openStream, store });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function waitFor(stream, type, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = stream.events.find((event) => event.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for a "${type}" event`);
}

/** A quiet-hours window in UTC that definitely contains "now". */
function quietWindowAroundNow() {
  const nowMinutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  return { start: formatClock(nowMinutes - 60), end: formatClock(nowMinutes + 60), tzOffsetMinutes: 0 };
}
function quietWindowLater() {
  const nowMinutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  return { start: formatClock(nowMinutes + 120), end: formatClock(nowMinutes + 180), tzOffsetMinutes: 0 };
}

/** Set up two users who share one channel. */
async function twoUsersInAChannel(signIn) {
  const ada = await signIn('ada');
  const grace = await signIn('grace');
  const { channel } = await ada.call('POST', '/api/channels', { name: 'engineering', topic: 'builds' });
  await grace.call('POST', `/api/channels/${channel.id}/join`);
  return { ada, grace, channel };
}

const notificationsOf = async (who) => (await who.call('GET', '/api/notifications')).notifications;
const channelOf = async (who, channelId) =>
  (await who.call('GET', '/api/state')).channels.find((c) => c.id === channelId);

// ─────────────────────────────────────────────────────────────────────────

test('username rules and session resume', async () => {
  await withServer(async ({ signIn, call }) => {
    const ada = await signIn('ada');
    assert.equal(ada.user.name, 'ada');

    const resumed = await call(ada.token, 'GET', '/api/session');
    assert.equal(resumed.user.id, ada.user.id);

    const again = await signIn('ADA');
    assert.equal(again.user.id, ada.user.id, 'usernames are case-insensitive and resume the account');

    assert.equal((await call(null, 'POST', '/api/session',
      { username: 'a', password: PASSWORD })).status, 400);
    assert.equal((await call(null, 'POST', '/api/session',
      { username: 'bad name!', password: PASSWORD })).status, 400);
    assert.equal((await call(null, 'POST', '/api/session', { username: 'ada' })).status, 400,
      'a password is required');
    assert.equal((await call(null, 'GET', '/api/state')).status, 401);
  });
});

test('join, post, read history, and leave a channel', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);

    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'first!' });
    const history = await grace.call('GET', `/api/channels/${channel.id}/messages`);
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].text, 'first!');
    assert.equal(history.messages[0].authorName, 'ada');

    await grace.call('POST', `/api/channels/${channel.id}/leave`);
    const denied = await grace.call('POST', `/api/channels/${channel.id}/messages`, { text: 'still here?' });
    assert.equal(denied.status, 403, 'you must be a member to post');

    const view = await channelOf(grace, channel.id);
    assert.equal(view.joined, false);
    assert.equal(view.memberCount, 1);
  });
});

test('unread counts rise for others, not the author, and clear on read', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);

    for (const text of ['one', 'two', 'three']) {
      await ada.call('POST', `/api/channels/${channel.id}/messages`, { text });
    }

    assert.equal((await channelOf(grace, channel.id)).unread, 3);
    assert.equal((await channelOf(ada, channel.id)).unread, 0, 'your own messages are never unread');

    await grace.call('POST', '/api/read', { conversationId: channel.id });
    assert.equal((await channelOf(grace, channel.id)).unread, 0);

    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'four' });
    assert.equal((await channelOf(grace, channel.id)).unread, 1, 'counting resumes from the read cursor');
  });
});

test('joining a channel does not inherit the backlog as unread', async () => {
  await withServer(async ({ signIn }) => {
    const ada = await signIn('ada');
    const { channel } = await ada.call('POST', '/api/channels', { name: 'general' });
    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'said before you arrived' });

    const grace = await signIn('grace');
    await grace.call('POST', `/api/channels/${channel.id}/join`);
    assert.equal((await channelOf(grace, channel.id)).unread, 0);

    const history = await grace.call('GET', `/api/channels/${channel.id}/messages`);
    assert.equal(history.messages.length, 1, 'history is still readable');
  });
});

test('@mentions notify; ordinary channel chatter does not', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);

    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'morning everyone' });
    assert.equal((await notificationsOf(grace)).length, 0, 'plain activity is unread-only');

    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'can @grace take a look?' });
    const notifications = await notificationsOf(grace);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].kind, 'mention');
    assert.equal(notifications[0].alert, true);
    assert.equal(notifications[0].channel.name, 'engineering');
    assert.equal(notifications[0].from.name, 'ada');

    const view = await channelOf(grace, channel.id);
    assert.equal(view.unread, 2);
    assert.equal(view.mentions, 1, 'mentions are counted separately from plain unread');

    assert.equal((await notificationsOf(ada)).length, 0, 'you are not notified about your own message');
  });
});

test('muting silences channel alerts but keeps counting unread', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);

    const muted = await grace.call('PATCH', `/api/channels/${channel.id}/prefs`, { muted: true });
    assert.equal(muted.channel.muted, true);

    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'noisy update' });
    assert.equal((await notificationsOf(grace)).length, 0);
    assert.equal((await channelOf(grace, channel.id)).unread, 1, 'muted channels still count unread');

    const unmuted = await grace.call('PATCH', `/api/channels/${channel.id}/prefs`, { muted: false });
    assert.equal(unmuted.channel.muted, false);
  });
});

test('@mentions bypass a channel mute', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);
    await grace.call('PATCH', `/api/channels/${channel.id}/prefs`, { muted: true });

    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'sorry to bug you @grace' });

    const [notification] = await notificationsOf(grace);
    assert.ok(notification, 'the mention got through the mute');
    assert.equal(notification.kind, 'mention');
    assert.equal(notification.alert, true);
    assert.equal(notification.bypassedMute, true);
  });
});

test('direct messages always notify, regardless of mutes', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);
    await grace.call('PATCH', `/api/channels/${channel.id}/prefs`, { muted: true });

    const sent = await ada.call('POST', `/api/dms/${grace.user.id}/messages`, { text: 'got a minute?' });
    assert.equal(sent.message.text, 'got a minute?');

    const [notification] = await notificationsOf(grace);
    assert.equal(notification.kind, 'direct');
    assert.equal(notification.alert, true);
    assert.equal(notification.channel, null);

    const thread = (await grace.call('GET', '/api/state')).dms.find((t) => t.userId === ada.user.id);
    assert.equal(thread.unread, 1);

    const conversation = await grace.call('GET', `/api/dms/${ada.user.id}/messages`);
    assert.equal(conversation.messages.length, 1);
    assert.equal(conversation.withUser.name, 'ada');

    // Both sides see the same thread.
    const adaSide = await ada.call('GET', `/api/dms/${grace.user.id}/messages`);
    assert.equal(adaSide.conversationId, conversation.conversationId);
    assert.equal(adaSide.unread, 0, 'the sender has already read their own message');
  });
});

test('quiet hours silence alerts without dropping notifications', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);

    const set = await grace.call('PATCH', '/api/settings/quiet-hours', {
      enabled: true, ...quietWindowAroundNow(),
    });
    assert.equal(set.active, true);

    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'ping @grace' });
    await ada.call('POST', `/api/dms/${grace.user.id}/messages`, { text: 'and a dm' });

    const notifications = await notificationsOf(grace);
    assert.equal(notifications.length, 2, 'nothing is dropped');
    assert.ok(notifications.every((n) => n.alert === false), 'everything is silenced');
    assert.ok(notifications.every((n) => n.silencedByQuietHours === true));
  });
});

test('allowDirect lets DMs ring through quiet hours', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);
    await grace.call('PATCH', '/api/settings/quiet-hours', {
      enabled: true, allowDirect: true, ...quietWindowAroundNow(),
    });

    await ada.call('POST', `/api/dms/${grace.user.id}/messages`, { text: 'urgent' });
    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'less urgent @grace' });

    const notifications = await notificationsOf(grace);
    const dm = notifications.find((n) => n.kind === 'direct');
    const mention = notifications.find((n) => n.kind === 'mention');
    assert.equal(dm.alert, true);
    assert.equal(mention.alert, false);
  });
});

test('a scheduled but inactive quiet-hours window does not silence anything', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace } = await twoUsersInAChannel(signIn);
    const set = await grace.call('PATCH', '/api/settings/quiet-hours', {
      enabled: true, ...quietWindowLater(),
    });
    assert.equal(set.active, false);

    await ada.call('POST', `/api/dms/${grace.user.id}/messages`, { text: 'hello' });
    const [notification] = await notificationsOf(grace);
    assert.equal(notification.alert, true);
  });
});

test('reading a conversation clears its notifications', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);
    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: '@grace ping' });
    await ada.call('POST', `/api/dms/${grace.user.id}/messages`, { text: 'dm too' });

    assert.equal((await notificationsOf(grace)).filter((n) => !n.read).length, 2);

    await grace.call('POST', '/api/read', { conversationId: channel.id });
    const remaining = (await notificationsOf(grace)).filter((n) => !n.read);
    assert.equal(remaining.length, 1, 'only the channel notification cleared');
    assert.equal(remaining[0].kind, 'direct');

    await grace.call('POST', '/api/notifications/read', {});
    assert.equal((await notificationsOf(grace)).filter((n) => !n.read).length, 0);
  });
});

test('channel creation is validated and names are unique', async () => {
  await withServer(async ({ signIn }) => {
    const ada = await signIn('ada');
    const created = await ada.call('POST', '/api/channels', { name: '#Design Review' });
    assert.equal(created.channel.name, 'design-review', 'normalised');
    assert.equal(created.channel.joined, true, 'the creator joins automatically');

    assert.equal((await ada.call('POST', '/api/channels', { name: 'design-review' })).status, 409);
    assert.equal((await ada.call('POST', '/api/channels', { name: '!!' })).status, 400);
  });
});

test('empty and oversized messages are rejected', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, channel } = await twoUsersInAChannel(signIn);
    assert.equal((await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: '   ' })).status, 400);
    assert.equal((await ada.call('POST', `/api/channels/${channel.id}/messages`,
      { text: 'x'.repeat(4001) })).status, 400);
  });
});

test('static assets are served and path traversal is refused', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Team Chat/);

    const escape = await fetch(base + '/../package.json');
    assert.ok(escape.status >= 400, `expected a refusal, got ${escape.status}`);
  });
});

test('the event stream pushes messages and names the DM partner on both sides', async () => {
  await withServer(async ({ signIn, openStream }) => {
    const ada = await signIn('ada');
    const grace = await signIn('grace');

    const adaStream = await openStream(ada.token);
    const graceStream = await openStream(grace.token);
    await waitFor(adaStream, 'hello');
    await waitFor(graceStream, 'hello');

    await ada.call('POST', `/api/dms/${grace.user.id}/messages`, { text: 'hello there' });

    const toGrace = await waitFor(graceStream, 'message');
    assert.equal(toGrace.data.message.text, 'hello there');
    assert.equal(toGrace.data.unread.unread, 1);
    // Conversation ids are opaque; the payload says who the thread is with.
    assert.equal(toGrace.data.direct.userId, ada.user.id);
    assert.equal(toGrace.data.direct.username, 'ada');

    const toAda = await waitFor(adaStream, 'message');
    assert.equal(toAda.data.direct.userId, grace.user.id, 'the sender sees the recipient, not themselves');
    assert.equal(toAda.data.unread.unread, 0);

    const notified = await waitFor(graceStream, 'notification');
    assert.equal(notified.data.notification.kind, 'direct');
    assert.equal((adaStream.events.find((e) => e.type === 'notification')), undefined,
      'the sender is not notified about their own DM');

    adaStream.close();
    graceStream.close();
  });
});

test('signing in announces the new user to everyone already connected', async () => {
  await withServer(async ({ signIn, openStream, call }) => {
    const ada = await signIn('ada');
    const adaStream = await openStream(ada.token);
    await waitFor(adaStream, 'hello');

    const grace = await signIn('grace');
    const announced = await waitFor(adaStream, 'user:joined');
    assert.equal(announced.data.user.id, grace.user.id);
    assert.equal(announced.data.user.name, 'grace');

    // Default channels are auto-joined, so member counts must refresh too.
    const membership = await waitFor(adaStream, 'channel:membership');
    assert.equal(membership.data.userId, grace.user.id);
    assert.equal(membership.data.action, 'joined');
    assert.equal(membership.data.memberCount, 2);

    const general = (await call(grace.token, 'GET', '/api/state')).channels
      .find((c) => c.name === 'general');
    assert.equal(general.joined, true, 'new members land in the default channels');

    adaStream.close();
  }, { seedDemo: true });
});

test('a channel message reaches every member and only mentions notify', async () => {
  await withServer(async ({ signIn, openStream }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);
    const graceStream = await openStream(grace.token);
    await waitFor(graceStream, 'hello');

    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'plain chatter' });
    const pushed = await waitFor(graceStream, 'message');
    assert.equal(pushed.data.channel.name, 'engineering');
    assert.equal(pushed.data.direct, null);
    assert.equal(graceStream.events.some((e) => e.type === 'notification'), false);

    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'over to you @grace' });
    const notified = await waitFor(graceStream, 'notification');
    assert.equal(notified.data.notification.kind, 'mention');

    graceStream.close();
  });
});

test('creating a channel tells the creator\'s other sessions they are in it', async () => {
  await withServer(async ({ signIn, openStream }) => {
    const ada = await signIn('ada');
    // A second session for the same person — another browser tab.
    const otherTab = await signIn('ada');
    assert.equal(otherTab.user.id, ada.user.id);

    const tabStream = await openStream(otherTab.token);
    await waitFor(tabStream, 'hello');

    const { channel } = await ada.call('POST', '/api/channels', { name: 'atlas' });

    const created = await waitFor(tabStream, 'channel:created');
    assert.equal(created.data.channel.name, 'atlas');

    const membership = await waitFor(tabStream, 'channel:membership');
    assert.equal(membership.data.channelId, channel.id);
    assert.equal(membership.data.userId, ada.user.id);
    assert.equal(membership.data.action, 'joined',
      'otherwise the other tab lists it under "browse" with a Join button');

    tabStream.close();
  });
});

// ───────────────────────────────  passwords  ─────────────────────────────

test('a new username registers; the same password signs back in', async () => {
  await withServer(async ({ call }) => {
    const first = await call(null, 'POST', '/api/session', { username: 'ada', password: PASSWORD });
    assert.equal(first.status, 200);
    assert.equal(first.created, true, 'first use of a name creates the account');
    assert.equal(first.user.name, 'ada');

    const second = await call(null, 'POST', '/api/session', { username: 'ada', password: PASSWORD });
    assert.equal(second.created, false, 'the second time is a sign-in, not a registration');
    assert.equal(second.user.id, first.user.id);
    assert.notEqual(second.token, first.token, 'each sign-in gets its own session token');
  });
});

test('a wrong password does not get you the account', async () => {
  await withServer(async ({ call }) => {
    await call(null, 'POST', '/api/session', { username: 'ada', password: PASSWORD });

    const wrong = await call(null, 'POST', '/api/session', { username: 'ada', password: 'not-the-password' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.token, undefined, 'no token is handed out');
    assert.match(wrong.error, /does not match/);

    // The account is untouched: the real password still works.
    const ok = await call(null, 'POST', '/api/session', { username: 'ada', password: PASSWORD });
    assert.equal(ok.status, 200);
  });
});

test('short passwords are refused', async () => {
  await withServer(async ({ call }) => {
    const short = await call(null, 'POST', '/api/session', { username: 'ada', password: 'abc' });
    assert.equal(short.status, 400);
    assert.match(short.error, /at least 8/);

    const long = await call(null, 'POST', '/api/session',
      { username: 'ada', password: 'x'.repeat(201) });
    assert.equal(long.status, 400);
  });
});

test('password material never leaves the server', async () => {
  await withServer(async ({ call, signIn }) => {
    const ada = await signIn('ada');
    await signIn('grace');

    const payloads = [
      await call(ada.token, 'GET', '/api/session'),
      await call(ada.token, 'GET', '/api/state'),
      await call(ada.token, 'GET', '/api/users'),
      await call(null, 'POST', '/api/session', { username: 'ada', password: PASSWORD }),
    ];

    for (const payload of payloads) {
      const text = JSON.stringify(payload);
      assert.doesNotMatch(text, /"auth"/, 'no auth object');
      assert.doesNotMatch(text, /"hash"/, 'no password hash');
      assert.doesNotMatch(text, /"salt"/, 'no salt');
      assert.doesNotMatch(text, new RegExp(PASSWORD), 'never the password itself');
    }
  });
});

test('repeated wrong passwords lock the username out', async () => {
  await withServer(async ({ call }) => {
    await call(null, 'POST', '/api/session', { username: 'ada', password: PASSWORD });

    let sawLock = null;
    for (let attempt = 0; attempt < 8 && !sawLock; attempt++) {
      const res = await call(null, 'POST', '/api/session', { username: 'ada', password: `wrong-guess-${attempt}` });
      if (res.status === 429) sawLock = res;
    }

    assert.ok(sawLock, 'guessing is throttled rather than allowed to run forever');
    assert.match(sawLock.error, /Try again in \d+s/);

    // The lock is per username, so other people can still sign in.
    const grace = await call(null, 'POST', '/api/session', { username: 'grace', password: PASSWORD });
    assert.equal(grace.status, 200);
  });
});

test('an account created before passwords is claimed on first sign-in', async () => {
  await withServer(async ({ call, store }) => {
    // Simulate a user loaded from a db.json written before this feature existed.
    const legacy = store.createUser('ada');
    assert.equal(legacy.auth, undefined);

    const claim = await call(null, 'POST', '/api/session', { username: 'ada', password: PASSWORD });
    assert.equal(claim.status, 200);
    assert.equal(claim.created, false, 'the account already existed');
    assert.equal(claim.claimed, true, 'but it had no password until now');
    assert.equal(claim.user.id, legacy.id, 'and it is the same account, history intact');

    // From here on it behaves like any other account.
    assert.equal((await call(null, 'POST', '/api/session',
      { username: 'ada', password: 'something-else' })).status, 401);
  });
});
