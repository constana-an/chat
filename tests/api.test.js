import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/index.js';
import { formatClock } from '../server/notifications.js';
import { parseSquare } from '../server/chess.js';

/** Boot a throwaway server (no persistence) and return a small client. */
const PASSWORD = 'correct-horse-battery';

async function withServer(run, { seedDemo = false } = {}) {
  const { server, store, scheduler, router } = createApp({ dataFile: null, seedDemo });
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
    await run({ base, signIn, call, openStream, store, scheduler, router });
  } finally {
    scheduler.stop();
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

// ─────────────────────────────────────────────────────────────  chess  ──

/** Challenge, accept, and hand back a client for each colour. */
async function startedGame(signIn) {
  const ada = await signIn('ada');
  const grace = await signIn('grace');
  const created = await ada.call('POST', '/api/games', { opponentId: grace.user.id });
  assert.equal(created.status, 200, created.error);
  await grace.call('POST', `/api/games/${created.game.id}/accept`);

  const byId = { [ada.user.id]: ada, [grace.user.id]: grace };
  const game = created.game;
  return {
    ada, grace, gameId: game.id,
    white: byId[game.white.id],
    black: byId[game.black.id],
  };
}

const move = (client, gameId, from, to, promotion) =>
  client.call('POST', `/api/games/${gameId}/moves`, {
    from: parseSquare(from), to: parseSquare(to), ...(promotion ? { promotion } : {}),
  });

test('a challenge assigns both colours and waits to be accepted', async () => {
  await withServer(async ({ signIn }) => {
    const ada = await signIn('ada');
    const grace = await signIn('grace');

    const { game } = await ada.call('POST', '/api/games', { opponentId: grace.user.id });
    assert.equal(game.status, 'pending');
    assert.notEqual(game.white.id, game.black.id, 'two different people');
    assert.deepEqual([game.white.id, game.black.id].sort(), [ada.user.id, grace.user.id].sort());
    assert.equal(game.turn, 'w');
    assert.equal(game.moves.length, 0);

    // The challenger cannot wave their own challenge through.
    assert.equal((await ada.call('POST', `/api/games/${game.id}/accept`)).status, 403);

    const accepted = await grace.call('POST', `/api/games/${game.id}/accept`);
    assert.equal(accepted.game.status, 'active');

    // The opponent hears about it like a direct message.
    const [notification] = (await grace.call('GET', '/api/notifications')).notifications;
    assert.match(notification.preview, /challenged you to chess/);
    assert.equal(notification.kind, 'direct');
    assert.equal(notification.gameId, game.id);
  });
});

test('only one live game per pair, and only the players can touch it', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, gameId } = await startedGame(signIn);
    const mallory = await signIn('mallory');

    assert.equal((await ada.call('POST', '/api/games', { opponentId: grace.user.id })).status, 409);
    assert.equal((await ada.call('POST', '/api/games', { opponentId: ada.user.id })).status, 400,
      'you cannot play yourself');

    assert.equal((await mallory.call('GET', `/api/games/${gameId}`)).status, 403);
    assert.equal((await move(mallory, gameId, 'e2', 'e4')).status, 403);
  });
});

test('the server owns legality: only real moves, only on your turn', async () => {
  await withServer(async ({ signIn }) => {
    const { gameId, white, black } = await startedGame(signIn);

    assert.equal((await move(black, gameId, 'e7', 'e5')).status, 409, 'black cannot open');
    assert.equal((await move(white, gameId, 'e2', 'e5')).status, 400, 'pawns do not jump three');
    assert.equal((await move(white, gameId, 'e1', 'e2')).status, 400, 'the king is boxed in');

    const played = await move(white, gameId, 'e2', 'e4');
    assert.equal(played.status, 200);
    assert.equal(played.game.moves.at(-1).san, 'e4', 'the move list reads as a scoresheet');
    assert.equal(played.game.turn, 'b');
    assert.equal(played.game.yourTurn, false, 'white has handed the move over');

    // Only the side to move is told what it may do.
    const blackView = await black.call('GET', `/api/games/${gameId}`);
    assert.equal(blackView.game.yourTurn, true);
    assert.ok(blackView.game.legalMoves.length > 0);
    assert.equal(played.game.legalMoves.length, 0, 'white is told nothing while waiting');
  });
});

test("fool's mate ends the game and names the winner", async () => {
  await withServer(async ({ signIn }) => {
    const { gameId, white, black } = await startedGame(signIn);

    await move(white, gameId, 'f2', 'f3');
    await move(black, gameId, 'e7', 'e5');
    await move(white, gameId, 'g2', 'g4');
    const mate = await move(black, gameId, 'd8', 'h4');

    assert.equal(mate.game.status, 'finished');
    assert.equal(mate.game.result.state, 'checkmate');
    assert.equal(mate.game.result.winner, 'b');
    assert.equal(mate.game.moves.at(-1).san, 'Qh4#', 'SAN carries the mate marker');

    // A finished game accepts nothing more.
    assert.equal((await move(white, gameId, 'a2', 'a3')).status, 409);

    const told = (await white.call('GET', '/api/notifications')).notifications;
    assert.ok(told.some((n) => /Checkmate\. You lose\./.test(n.preview)), 'the loser is told plainly');
  });
});

test('resigning and declining both end things cleanly', async () => {
  await withServer(async ({ signIn }) => {
    const resigned = await startedGame(signIn);
    const out = await resigned.white.call('POST', `/api/games/${resigned.gameId}/resign`);
    assert.equal(out.game.status, 'finished');
    assert.equal(out.game.result.state, 'resigned');
    assert.equal(out.game.result.winner, 'b', 'white resigned, so black wins');

    const notified = (await resigned.black.call('GET', '/api/notifications')).notifications;
    assert.ok(notified.some((n) => /resigned\. You win\./.test(n.preview)));
  });

  await withServer(async ({ signIn }) => {
    const ada = await signIn('ada');
    const grace = await signIn('grace');
    const { game } = await ada.call('POST', '/api/games', { opponentId: grace.user.id });

    const declined = await grace.call('POST', `/api/games/${game.id}/decline`);
    assert.equal(declined.game.status, 'finished');
    assert.equal(declined.game.result.state, 'declined');
    // With nothing live, a fresh challenge is allowed again.
    assert.equal((await ada.call('POST', '/api/games', { opponentId: grace.user.id })).status, 200);
  });
});

test('"your move" replaces itself instead of stacking up', async () => {
  await withServer(async ({ signIn }) => {
    const { gameId, white, black } = await startedGame(signIn);

    const openings = [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6']];
    for (const [from, to] of openings) {
      const mover = (await white.call('GET', `/api/games/${gameId}`)).game.yourTurn ? white : black;
      assert.equal((await move(mover, gameId, from, to)).status, 200, `${from}${to}`);
    }

    for (const player of [white, black]) {
      const turns = (await player.call('GET', '/api/notifications')).notifications
        .filter((n) => n.gameId === gameId && !n.read && /Your move/.test(n.preview));
      assert.ok(turns.length <= 1, `six moves left ${turns.length} unread turn notices`);
    }
  });
});

test('both players are pushed every position over the event stream', async () => {
  await withServer(async ({ signIn, openStream }) => {
    const { gameId, white, black } = await startedGame(signIn);
    const whiteStream = await openStream(white.token);
    const blackStream = await openStream(black.token);
    await waitFor(whiteStream, 'hello');
    await waitFor(blackStream, 'hello');

    await move(white, gameId, 'd2', 'd4');

    for (const [label, stream] of [['white', whiteStream], ['black', blackStream]]) {
      const event = await waitFor(stream, 'game');
      assert.equal(event.data.game.moves.at(-1).san, 'd4', `${label} saw the move`);
      assert.equal(event.data.game.board[parseSquare('d4')], 'P', `${label} got the new position`);
    }

    // Each side is told about its own turn, not the other's.
    const whiteGame = whiteStream.events.filter((e) => e.type === 'game').at(-1).data.game;
    const blackGame = blackStream.events.filter((e) => e.type === 'game').at(-1).data.game;
    assert.equal(whiteGame.yourTurn, false);
    assert.equal(blackGame.yourTurn, true);
    assert.equal(whiteGame.yourColor, 'w');
    assert.equal(blackGame.yourColor, 'b');

    whiteStream.close();
    blackStream.close();
  });
});

test('the sidebar learns whose move it is', async () => {
  await withServer(async ({ signIn }) => {
    const { gameId, white, black } = await startedGame(signIn);

    const threadFor = async (client, otherName) =>
      (await client.call('GET', '/api/state')).dms.find((t) => t.username === otherName);

    const whiteName = (await white.call('GET', '/api/session')).user.name;
    const blackName = (await black.call('GET', '/api/session')).user.name;

    assert.equal((await threadFor(white, blackName)).game.yourTurn, true);
    assert.equal((await threadFor(black, whiteName)).game.yourTurn, false);

    await move(white, gameId, 'e2', 'e4');
    assert.equal((await threadFor(white, blackName)).game.yourTurn, false);
    assert.equal((await threadFor(black, whiteName)).game.yourTurn, true);
  });
});

// ─────────────────────────────────  rock, paper, scissors  ──────────────

async function rpsGame(signIn) {
  const ada = await signIn('ada');
  const grace = await signIn('grace');
  const created = await ada.call('POST', '/api/games', { opponentId: grace.user.id, kind: 'rps' });
  assert.equal(created.status, 200, created.error);
  return { ada, grace, gameId: created.game.id, game: created.game };
}

const throwIt = (client, gameId, choice) =>
  client.call('POST', `/api/games/${gameId}/throw`, { choice });

test('rock-paper-scissors starts straight away, no accepting needed', async () => {
  await withServer(async ({ signIn }) => {
    const { grace, gameId, game } = await rpsGame(signIn);
    assert.equal(game.kind, 'rps');
    assert.equal(game.status, 'active');
    assert.equal(game.target, 2, 'best of three');
    assert.equal(game.yourScore, 0);
    assert.equal(game.waitingForYou, true);

    const theirs = await grace.call('GET', `/api/games/${gameId}`);
    assert.equal(theirs.game.waitingForYou, true, 'both sides may throw at once');
    assert.equal(theirs.game.opponent.name, 'ada');
  });
});

test('an opponent\'s pending throw never leaves the server', async () => {
  for (const secret of ['rock', 'paper', 'scissors']) {
    await withServer(async ({ signIn, openStream }) => {
      const { ada, grace, gameId } = await rpsGame(signIn);
      const spy = await openStream(grace.token);
      await waitFor(spy, 'hello');

      await throwIt(ada, gameId, secret);

      // Fetching the game tells grace only *that* ada has thrown.
      const view = await grace.call('GET', `/api/games/${gameId}`);
      assert.equal(view.game.opponentHasThrown, true);
      assert.equal(view.game.yourThrow, null);
      assert.doesNotMatch(JSON.stringify(view), new RegExp(secret),
        `the API leaked "${secret}" before grace threw`);

      // Neither does the push she gets over the event stream.
      const pushed = await waitFor(spy, 'game');
      assert.doesNotMatch(JSON.stringify(pushed), new RegExp(secret),
        `the event stream leaked "${secret}"`);

      // ada, of course, can still see her own hand.
      const mine = await ada.call('GET', `/api/games/${gameId}`);
      assert.equal(mine.game.yourThrow, secret);
      spy.close();
    });
  }
});

test('once both have thrown the round resolves and is public', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, gameId } = await rpsGame(signIn);

    await throwIt(ada, gameId, 'rock');
    const resolved = await throwIt(grace, gameId, 'scissors');

    assert.equal(resolved.game.rounds.length, 1);
    assert.deepEqual(resolved.game.rounds[0], { yours: 'scissors', theirs: 'rock', outcome: 'loss' });
    assert.equal(resolved.game.yourScore, 0);
    assert.equal(resolved.game.opponentScore, 1);

    // The same round from the other side, mirrored.
    const adaSide = (await ada.call('GET', `/api/games/${gameId}`)).game;
    assert.deepEqual(adaSide.rounds[0], { yours: 'rock', theirs: 'scissors', outcome: 'win' });
    assert.equal(adaSide.yourScore, 1);

    // The board is wiped for the next round.
    assert.equal(adaSide.yourThrow, null);
    assert.equal(adaSide.waitingForYou, true);
  });
});

test('a tie scores for nobody and the round is replayed', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, gameId } = await rpsGame(signIn);

    await throwIt(ada, gameId, 'paper');
    const tied = await throwIt(grace, gameId, 'paper');

    assert.equal(tied.game.rounds[0].outcome, 'tie');
    assert.equal(tied.game.yourScore, 0);
    assert.equal(tied.game.opponentScore, 0);
    assert.equal(tied.game.status, 'active');
    assert.equal(tied.game.waitingForYou, true, 'go again');
  });
});

test('you cannot throw twice in one round', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, gameId } = await rpsGame(signIn);
    assert.equal((await throwIt(ada, gameId, 'rock')).status, 200);

    const again = await throwIt(ada, gameId, 'paper');
    assert.equal(again.status, 409, 'no changing your mind after seeing nothing');

    assert.equal((await throwIt(ada, gameId, 'lizard')).status, 400, 'and no inventing throws');
  });
});

test('first to two takes the match', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, gameId } = await rpsGame(signIn);

    await throwIt(ada, gameId, 'rock');
    await throwIt(grace, gameId, 'scissors');       // ada 1–0
    await throwIt(ada, gameId, 'paper');
    const done = await throwIt(grace, gameId, 'rock'); // ada 2–0

    assert.equal(done.game.status, 'finished');
    assert.equal(done.game.result.state, 'won');
    assert.equal(done.game.yourScore, 0);
    assert.equal(done.game.opponentScore, 2);
    assert.equal((await throwIt(ada, gameId, 'rock')).status, 409, 'the match is closed');

    const told = (await grace.call('GET', '/api/notifications')).notifications;
    assert.ok(told.some((n) => /You lose 0–2/.test(n.preview)), 'the loser is told the score');
    assert.ok(told.every((n) => !n.preview.startsWith('♟')), 'a hand of RPS is not labelled with a chess piece');
  });
});

test('a chess game and a hand of rock-paper-scissors can run side by side', async () => {
  await withServer(async ({ signIn }) => {
    const ada = await signIn('ada');
    const grace = await signIn('grace');

    const chess = await ada.call('POST', '/api/games', { opponentId: grace.user.id });
    const rps = await ada.call('POST', '/api/games', { opponentId: grace.user.id, kind: 'rps' });
    assert.equal(chess.status, 200);
    assert.equal(rps.status, 200);
    assert.notEqual(chess.game.id, rps.game.id);

    // But still only one of each.
    assert.equal((await ada.call('POST', '/api/games', { opponentId: grace.user.id, kind: 'rps' })).status, 409);

    const thread = (await ada.call('GET', '/api/state')).dms.find((t) => t.username === 'grace');
    assert.equal(thread.game.id, chess.game.id, 'the sidebar tracks the chess game');
    assert.equal(thread.rps.id, rps.game.id, 'and the hand of RPS separately');
    assert.equal(thread.rps.waitingForYou, true);

    // Throwing at a chess game, or moving in a hand of RPS, is refused.
    assert.equal((await throwIt(ada, chess.game.id, 'rock')).status, 400);
  });
});

// ────────────────────────────────────────────────  dice  ────────────────

test('/roll posts a roll, not a line of text', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);

    const rolled = await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: '/roll 3d6' });
    assert.equal(rolled.status, 200);

    const message = rolled.message;
    assert.equal(message.kind, 'roll');
    assert.equal(message.roll.notation, '3d6');
    assert.equal(message.roll.values.length, 3);
    assert.ok(message.roll.values.every((v) => v >= 1 && v <= 6), message.roll.values.join());
    assert.equal(message.roll.total, message.roll.values.reduce((a, b) => a + b, 0));
    assert.match(message.text, /^🎲 3d6:/, 'it still reads as text for anything that cannot draw dice');

    // Everyone in the channel gets it through the ordinary history and unread paths.
    const seen = (await grace.call('GET', `/api/channels/${channel.id}/messages`)).messages.at(-1);
    assert.equal(seen.kind, 'roll');
    assert.deepEqual(seen.roll.values, message.roll.values);
    assert.equal((await channelOf(grace, channel.id)).unread, 1, 'a roll counts as unread like any message');
  });
});

test('a roll is channel activity — it notifies nobody', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);
    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: '/roll' });
    assert.equal((await grace.call('GET', '/api/notifications')).notifications.length, 0);
  });
});

test('a bad roll is refused with a reason and posts nothing', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, channel } = await twoUsersInAChannel(signIn);

    const tooMany = await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: '/roll 99d6' });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.error, /between 1 and 10 dice/);

    const nonsense = await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: '/roll banana' });
    assert.equal(nonsense.status, 400);
    assert.match(nonsense.error, /\/roll d20/);

    assert.equal((await ada.call('GET', `/api/channels/${channel.id}/messages`)).messages.length, 0,
      'nothing was posted');
  });
});

test('a roll works in a direct message too, and does not eat ordinary text', async () => {
  await withServer(async ({ signIn }) => {
    const ada = await signIn('ada');
    const grace = await signIn('grace');

    const rolled = await ada.call('POST', `/api/dms/${grace.user.id}/messages`, { text: '/roll d20' });
    assert.equal(rolled.message.kind, 'roll');
    assert.ok(rolled.message.roll.total >= 1 && rolled.message.roll.total <= 20);

    const plain = await ada.call('POST', `/api/dms/${grace.user.id}/messages`, { text: 'we should /roll for it' });
    assert.equal(plain.message.kind, 'text');
    assert.equal(plain.message.roll, null);
    assert.equal(plain.message.text, 'we should /roll for it');
  });
});

// ────────────────────────────── snooze (change 1) ───────────────────────

test('a channel can be muted for a fixed time', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);

    const before = Date.now();
    const snoozed = await grace.call('PATCH', `/api/channels/${channel.id}/prefs`,
      { muted: true, minutes: 60 });
    assert.equal(snoozed.status, 200);
    assert.equal(snoozed.channel.muted, true);

    const until = snoozed.channel.mutedUntil;
    assert.ok(typeof until === 'number', 'the view carries an end time');
    const hour = 60 * 60_000;
    assert.ok(until >= before + hour && until <= Date.now() + hour + 1000,
      'roughly an hour from now, so a client can show the remaining time');

    // While it lasts it behaves exactly like any other mute.
    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'routine' });
    assert.equal((await notificationsOf(grace)).length, 0, 'silent');
    assert.equal((await channelOf(grace, channel.id)).unread, 1, 'but still counted');

    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'over to you @grace' });
    const [mention] = await notificationsOf(grace);
    assert.equal(mention.bypassedMute, true, 'and a mention still gets through');
  });
});

test('an indefinite mute reports no end time', async () => {
  await withServer(async ({ signIn }) => {
    const { grace, channel } = await twoUsersInAChannel(signIn);
    const muted = await grace.call('PATCH', `/api/channels/${channel.id}/prefs`, { muted: true });
    assert.equal(muted.channel.muted, true);
    assert.equal(muted.channel.mutedUntil, null, 'null distinguishes "forever" from "until 15:40"');

    const off = await grace.call('PATCH', `/api/channels/${channel.id}/prefs`, { muted: false });
    assert.equal(off.channel.muted, false);
    assert.equal(off.channel.mutedUntil, null);
  });
});

test('a snooze cannot quietly become a permanent mute', async () => {
  await withServer(async ({ signIn }) => {
    const { grace, channel } = await twoUsersInAChannel(signIn);
    const path = `/api/channels/${channel.id}/prefs`;

    assert.equal((await grace.call('PATCH', path, { muted: true, minutes: 0 })).status, 400);
    assert.equal((await grace.call('PATCH', path, { muted: true, minutes: -5 })).status, 400);
    assert.equal((await grace.call('PATCH', path, { muted: true, minutes: 'soon' })).status, 400);

    const tooLong = await grace.call('PATCH', path, { muted: true, minutes: 8 * 24 * 60 });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.error, /between 1 and \d+ minutes/);

    assert.equal((await channelOf(grace, channel.id)).muted, false, 'and none of them muted anything');
  });
});

// ─────────────────────── scheduled messages (change 2) ──────────────────

const soon = (ms = 40) => Date.now() + ms;

/** Let the due time pass, then force a pass so the test does not race a timer. */
async function runScheduler(scheduler, waitMs = 80) {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  await scheduler.tick();
}

test('scheduling writes no message: no history, no unread, no mention', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);

    const queued = await ada.call('POST', `/api/channels/${channel.id}/messages`,
      { text: 'heads up @grace', deliverAt: Date.now() + 60_000 });
    assert.equal(queued.status, 200);
    assert.equal(queued.scheduled.status, 'pending');
    assert.equal(queued.message, undefined, 'nothing was posted');

    // The requirement in one assertion block: none of this moves yet.
    assert.equal((await grace.call('GET', `/api/channels/${channel.id}/messages`)).messages.length, 0);
    assert.equal((await channelOf(grace, channel.id)).unread, 0);
    assert.equal((await channelOf(grace, channel.id)).mentions, 0);
    assert.equal((await notificationsOf(grace)).length, 0);

    // Only the author knows it exists.
    assert.equal((await ada.call('GET', '/api/scheduled')).scheduled.length, 1);
    assert.equal((await grace.call('GET', '/api/scheduled')).scheduled.length, 0);
  });
});

test('at delivery it becomes an ordinary message — mentions and unread land then', async () => {
  await withServer(async ({ signIn, scheduler }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);

    await ada.call('POST', `/api/channels/${channel.id}/messages`,
      { text: 'heads up @grace', deliverAt: soon() });
    await runScheduler(scheduler);

    const history = (await grace.call('GET', `/api/channels/${channel.id}/messages`)).messages;
    assert.equal(history.length, 1);
    assert.equal(history[0].text, 'heads up @grace');
    assert.equal(history[0].authorName, 'ada');

    const view = await channelOf(grace, channel.id);
    assert.equal(view.unread, 1, 'unread starts now, not at compose time');
    assert.equal(view.mentions, 1, 'and so does the mention');

    const [notification] = await notificationsOf(grace);
    assert.equal(notification.kind, 'mention');
    assert.equal(notification.alert, true);

    assert.equal((await ada.call('GET', '/api/scheduled')).scheduled.length, 0, 'the queue is cleared');
  });
});

test('a scheduled roll is rolled when it is sent, not when it is written', async () => {
  await withServer(async ({ signIn, scheduler }) => {
    const { ada, channel } = await twoUsersInAChannel(signIn);
    await ada.call('POST', `/api/channels/${channel.id}/messages`,
      { text: '/roll 2d6', deliverAt: soon() });
    await runScheduler(scheduler);

    const [message] = (await ada.call('GET', `/api/channels/${channel.id}/messages`)).messages;
    assert.equal(message.kind, 'roll', 'the whole write was deferred, so the dice fell late');
    assert.equal(message.roll.values.length, 2);
  });
});

test('scheduled direct messages work the same way', async () => {
  await withServer(async ({ signIn, scheduler }) => {
    const ada = await signIn('ada');
    const grace = await signIn('grace');

    await ada.call('POST', `/api/dms/${grace.user.id}/messages`,
      { text: 'morning', deliverAt: soon() });
    assert.equal((await grace.call('GET', `/api/dms/${ada.user.id}/messages`)).messages.length, 0);

    await runScheduler(scheduler);
    const conversation = await grace.call('GET', `/api/dms/${ada.user.id}/messages`);
    assert.equal(conversation.messages.length, 1);
    assert.equal(conversation.unread, 1);
    assert.equal((await notificationsOf(grace))[0].kind, 'direct');
  });
});

test('the author can list and cancel; nobody else can', async () => {
  await withServer(async ({ signIn, scheduler }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);
    const { scheduled } = await ada.call('POST', `/api/channels/${channel.id}/messages`,
      { text: 'never mind', deliverAt: soon(120) });

    assert.equal((await grace.call('DELETE', `/api/scheduled/${scheduled.id}`)).status, 403);
    assert.equal((await ada.call('DELETE', `/api/scheduled/${scheduled.id}`)).cancelled, scheduled.id);
    assert.equal((await ada.call('GET', '/api/scheduled')).scheduled.length, 0);

    await runScheduler(scheduler, 160);
    assert.equal((await ada.call('GET', `/api/channels/${channel.id}/messages`)).messages.length, 0,
      'a cancelled message never arrives');
  });
});

test('impossible schedules are refused up front, not silently at delivery', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);
    const path = `/api/channels/${channel.id}/messages`;

    assert.equal((await ada.call('POST', path, { text: 'x', deliverAt: Date.now() - 1000 })).status, 400);
    assert.equal((await ada.call('POST', path, { text: 'x', deliverAt: 'tomorrow' })).status, 400);
    assert.match((await ada.call('POST', path,
      { text: 'x', deliverAt: Date.now() + 400 * 24 * 3600_000 })).error, /at most a year/);
    assert.equal((await ada.call('POST', path, { text: '   ', deliverAt: soon(9999) })).status, 400,
      'an empty message fails now rather than at 3am');

    // Someone who is not a member cannot queue into the channel either.
    await grace.call('POST', `/api/channels/${channel.id}/leave`);
    assert.equal((await grace.call('POST', path, { text: 'x', deliverAt: soon(9999) })).status, 403);
  });
});

test('a send that becomes impossible is recorded, not lost in silence', async () => {
  await withServer(async ({ signIn, scheduler }) => {
    const { ada, channel } = await twoUsersInAChannel(signIn);
    await ada.call('POST', `/api/channels/${channel.id}/messages`,
      { text: 'still here?', deliverAt: soon() });

    // The world changes between writing and sending.
    await ada.call('POST', `/api/channels/${channel.id}/leave`);
    await runScheduler(scheduler);

    const [item] = (await ada.call('GET', '/api/scheduled')).scheduled;
    assert.equal(item.status, 'failed');
    assert.match(item.error, /Join #/);
    assert.equal((await ada.call('GET', `/api/channels/${channel.id}/messages`)).messages.length, 0);
  });
});

test('a message scheduled before a restart still arrives after it', async () => {
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'teamchat-')), 'db.json');

  /** Boot an app on the shared data file and hand back a signed-in client. */
  const boot = async () => {
    const app = createApp({ dataFile, seedDemo: false });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (token, method, p, body) => {
      const res = await fetch(base + p, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
                   ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, ...(await res.json().catch(() => ({}))) };
    };
    const signIn = async (username) => {
      const { token } = await call(null, 'POST', '/api/session', { username, password: PASSWORD });
      return { token, call: (m, p, b) => call(token, m, p, b) };
    };
    const close = async () => {
      app.scheduler.stop();
      app.server.closeAllConnections?.();
      await new Promise((resolve) => app.server.close(resolve));
    };
    return { ...app, signIn, close };
  };

  let channelId;
  const first = await boot();
  try {
    const ada = await first.signIn('ada');
    const { channel } = await ada.call('POST', '/api/channels', { name: 'general' });
    channelId = channel.id;
    // Far enough out that it cannot possibly fire before we pull the plug.
    const { scheduled } = await ada.call('POST', `/api/channels/${channelId}/messages`,
      { text: 'sent across a restart', deliverAt: Date.now() + 250 });
    assert.equal(scheduled.status, 'pending');
  } finally {
    await first.close();
  }

  // Everything in memory is gone; only db.json survives.
  const second = await boot();
  try {
    const ada = await second.signIn('ada');
    assert.equal((await ada.call('GET', '/api/scheduled')).scheduled.length, 1,
      'the new process restored it from disk');

    await new Promise((resolve) => setTimeout(resolve, 300));
    await second.scheduler.tick();

    const history = (await ada.call('GET', `/api/channels/${channelId}/messages`)).messages;
    assert.equal(history.length, 1, 'and delivered it');
    assert.equal(history[0].text, 'sent across a restart');
    assert.equal((await ada.call('GET', '/api/scheduled')).scheduled.length, 0);
  } finally {
    await second.close();
    fs.rmSync(path.dirname(dataFile), { recursive: true, force: true });
  }
});

// ─────────────────────────────── digest (change 3) ──────────────────────

/** A real timestamp past the interval — Infinity is not a valid Date. */
const afterInterval = (minutes = 5) => Date.now() + (minutes + 1) * 60_000;

test('with a digest on, mentions are held and DMs are not', async () => {
  await withServer(async ({ signIn, router }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);
    await grace.call('PATCH', '/api/settings/digest', { enabled: true, everyMinutes: 5 });

    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'one @grace' });
    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'two @grace' });

    assert.equal((await notificationsOf(grace)).length, 0, 'the inbox stays quiet');
    assert.equal((await channelOf(grace, channel.id)).mentions, 2, 'but they still count');
    assert.equal((await channelOf(grace, channel.id)).unread, 2);

    // A direct message refuses to wait.
    await ada.call('POST', `/api/dms/${grace.user.id}/messages`, { text: 'this one is urgent' });
    const inbox = await notificationsOf(grace);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].kind, 'direct');
    assert.equal(inbox[0].alert, true);

    // When the interval passes, two mentions become one entry.
    router.flushDigests(afterInterval());
    const after = await notificationsOf(grace);
    const digest = after.find((n) => n.kind === 'digest');
    assert.ok(digest, 'the digest arrived');
    assert.equal(digest.items.length, 2);
    assert.match(digest.preview, /2 mentions/);
    assert.equal(digest.alert, true);
    assert.deepEqual(digest.items.map((i) => i.preview), ['one @grace', 'two @grace']);
    assert.equal(after.filter((n) => n.kind === 'mention').length, 0, 'and replaced them, not joined them');
  });
});

test('a digest that lands inside quiet hours is silenced as one thing', async () => {
  await withServer(async ({ signIn, router }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);
    await grace.call('PATCH', '/api/settings/digest', { enabled: true, everyMinutes: 5 });
    await grace.call('PATCH', '/api/settings/quiet-hours', { enabled: true, ...quietWindowAroundNow() });

    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'held @grace' });
    router.flushDigests(afterInterval());

    const digest = (await notificationsOf(grace)).find((n) => n.kind === 'digest');
    assert.ok(digest);
    assert.equal(digest.alert, false, 'quiet hours applies to the digest, not to each held item');
    assert.equal(digest.silencedByQuietHours, true);
    assert.match(digest.reason, /silenced by quiet hours/);
  });
});

test('turning the digest off releases what it was holding', async () => {
  await withServer(async ({ signIn }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);
    await grace.call('PATCH', '/api/settings/digest', { enabled: true });
    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'stuck @grace' });
    assert.equal((await notificationsOf(grace)).length, 0);

    const off = await grace.call('PATCH', '/api/settings/digest', { enabled: false });
    assert.equal(off.digest.enabled, false);
    assert.equal(off.held, 0, 'nothing is left holding');

    const released = await notificationsOf(grace);
    assert.equal(released.length, 1, 'it was not stranded');
    assert.equal(released[0].kind, 'digest');

    // And from now on mentions come through immediately again.
    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'again @grace' });
    assert.ok((await notificationsOf(grace)).some((n) => n.kind === 'mention'));
  });
});

test('an empty digest is never sent', async () => {
  await withServer(async ({ signIn, router }) => {
    const { grace } = await twoUsersInAChannel(signIn);
    await grace.call('PATCH', '/api/settings/digest', { enabled: true });
    router.flushDigests(afterInterval());
    assert.equal((await notificationsOf(grace)).length, 0);
  });
});

test('held items are not pushed over the event stream either', async () => {
  await withServer(async ({ signIn, openStream }) => {
    const { ada, grace, channel } = await twoUsersInAChannel(signIn);
    await grace.call('PATCH', '/api/settings/digest', { enabled: true });

    const spy = await openStream(grace.token);
    await waitFor(spy, 'hello');
    await ada.call('POST', `/api/channels/${channel.id}/messages`, { text: 'quiet please @grace' });
    await waitFor(spy, 'message');   // she still sees the message and the unread count

    assert.equal(spy.events.some((e) => e.type === 'notification'), false,
      'but nothing was pushed that would light up the bell');
    spy.close();
  });
});
