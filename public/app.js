/**
 * Team Chat client.
 *
 * The session token lives in sessionStorage, which is per-tab: open a second
 * tab and you can sign in as a different person and talk to yourself.
 */

const TOKEN_KEY = 'teamchat.token';

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) ?? null,
  me: null,
  users: new Map(),            // userId -> {id, name, online}
  channels: new Map(),         // channelId -> channel view
  dms: new Map(),              // otherUserId -> thread view
  messages: new Map(),         // conversationId -> message[]
  notifications: [],
  scheduled: [],             // 我写好但还没发出去的消息
  current: null,               // {kind:'channel'|'dm', id, conversationId}
  game: null,                  // 当前私信里的棋局视图
  rps: null,                   // 当前私信里的石头剪刀布视图
  chessFrom: null,             // 选中的格子
  chessPromotion: null,        // {from, to} 等待选择升变棋子
  markers: new Map(),          // conversationId -> seq of the "new messages" line
  streamAbort: null,
};

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// ────────────────────────────────  api  ──────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(payload.error ?? res.statusText), { status: res.status });
  return payload;
}

// ──────────────────────────────  sign in  ────────────────────────────────

$('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = $('signin-username').value.trim().toLowerCase();
  const password = $('signin-password').value;
  const error = $('signin-error');
  const submit = $('signin-submit');

  error.hidden = true;
  // Hashing takes about a tenth of a second; do not let it be submitted twice.
  submit.disabled = true;
  submit.textContent = 'Checking…';

  try {
    const { token, user, created } = await api('POST', '/api/session', { username, password });
    state.token = token;
    state.me = user;
    sessionStorage.setItem(TOKEN_KEY, token);
    $('signin-password').value = '';
    await start();
    if (created) flashHint(`Account created for @${user.name}. Remember that password.`);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    $('signin-password').select();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Join';
  }
});

$('btn-signout').addEventListener('click', async () => {
  try { await api('DELETE', '/api/session'); } catch { /* already gone */ }
  sessionStorage.removeItem(TOKEN_KEY);
  location.reload();
});

async function boot() {
  if (!state.token) return showSignIn();
  try {
    const { user } = await api('GET', '/api/session');
    state.me = user;
    await start();
  } catch {
    sessionStorage.removeItem(TOKEN_KEY);
    state.token = null;
    showSignIn();
  }
}

function showSignIn() {
  $('signin').hidden = false;
  $('app').hidden = true;
  $('signin-username').focus();
}

async function start() {
  $('signin').hidden = true;
  $('app').hidden = false;
  // Tell the server which timezone the quiet-hours window is expressed in.
  await api('PATCH', '/api/settings/quiet-hours', { tzOffsetMinutes: -new Date().getTimezoneOffset() })
    .catch(() => {});
  await refreshState();
  connectStream();

  const first = [...state.channels.values()].find((c) => c.joined) ?? [...state.channels.values()][0];
  if (first) openChannel(first.id);
  else renderConversation();
}

async function refreshState() {
  const data = await api('GET', '/api/state');
  state.me = data.user;
  state.users = new Map(data.users.map((u) => [u.id, u]));
  state.channels = new Map(data.channels.map((c) => [c.id, c]));
  state.dms = new Map(data.dms.map((t) => [t.userId, t]));
  state.notifications = data.notifications;
  state.scheduled = data.scheduled ?? [];
  renderAll();
}

// ────────────────────────────  event stream  ─────────────────────────────

/**
 * SSE over fetch rather than EventSource, because EventSource cannot send an
 * Authorization header and we do not want session tokens in URLs.
 */
async function connectStream() {
  state.streamAbort?.abort();
  const controller = new AbortController();
  state.streamAbort = controller;

  try {
    const res = await fetch('/api/events', {
      headers: { Authorization: `Bearer ${state.token}` },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error('stream unavailable');

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        handleFrame(frame);
      }
    }
  } catch (err) {
    if (controller.signal.aborted) return;
  }
  // Dropped connection: back off briefly, resync, reconnect.
  setTimeout(() => { refreshState().catch(() => {}); connectStream(); }, 1500);
}

function handleFrame(frame) {
  let type = 'message';
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }
  if (!dataLines.length) return; // keep-alive comment
  let data;
  try { data = JSON.parse(dataLines.join('\n')); } catch { return; }
  onEvent(type, data);
}

function onEvent(type, data) {
  switch (type) {
    case 'message': return onMessage(data);
    case 'notification': return onNotification(data.notification);
    case 'read': return onRead(data);
    case 'notifications:read': return onNotificationsRead(data);
    case 'prefs': return onPrefs(data);
    case 'presence': return onPresence(data);
    case 'scheduled': return onScheduled(data.scheduled);
    case 'game': return onGame(data.game);
    case 'user:joined': return onUserJoined(data.user);
    case 'channel:created': return onChannelCreated(data.channel);
    case 'channel:membership': return onMembership(data);
    default: return undefined;
  }
}

function onMessage({ message, channel, direct, unread }) {
  const cached = state.messages.get(message.conversationId);
  if (cached && !cached.some((m) => m.id === message.id)) {
    cached.push(message);
    if (cached.length > 500) cached.splice(0, cached.length - 500);
  }

  if (channel) {
    const view = state.channels.get(channel.id);
    if (view) Object.assign(view, { unread: unread.unread, mentions: unread.mentions, lastMessage: message });
  } else {
    const otherId = direct?.userId ?? message.authorId;
    const thread = state.dms.get(otherId) ?? {
      conversationId: message.conversationId,
      userId: otherId,
      username: state.users.get(otherId)?.name ?? direct?.username ?? 'unknown',
      unread: 0, mentions: 0,
    };
    Object.assign(thread, { unread: unread.unread, mentions: unread.mentions, lastMessage: message });
    state.dms.set(otherId, thread);
  }

  const isCurrent = state.current?.conversationId === message.conversationId;
  if (isCurrent) {
    const atBottom = isScrolledToBottom();
    renderMessages();
    if (atBottom) scrollToBottom();
    if (document.hasFocus()) markCurrentRead();
  }
  renderSidebar();
}

function onNotification(notification) {
  state.notifications.unshift(notification);
  renderInbox();
  renderBadge();
  if (notification.alert) {
    showToast(notification);
    beep(notification.kind === 'mention');
  }
}

function onRead({ conversationId, unread, clearedNotifications }) {
  applyUnread(conversationId, unread);
  // Reading a conversation also clears the notifications that pointed at it.
  if (clearedNotifications?.length) {
    for (const notification of state.notifications) {
      if (clearedNotifications.includes(notification.id)) notification.read = true;
    }
    renderInbox();
    renderBadge();
  }
  renderSidebar();
}

function onNotificationsRead({ ids }) {
  for (const n of state.notifications) {
    if (!ids || ids.includes(n.id)) n.read = true;
  }
  renderInbox();
  renderBadge();
}

function onPrefs({ channels, quietHours, digest }) {
  if (channels) state.channels = new Map(channels.map((c) => [c.id, c]));
  if (quietHours) state.me.prefs.quietHours = quietHours;
  if (digest) state.me.prefs.digest = digest;
  renderAll();
}

function onUserJoined(user) {
  if (user.id === state.me.id || state.users.has(user.id)) return;
  state.users.set(user.id, user);
  renderSidebar();
}

function onPresence({ userId, online }) {
  const user = state.users.get(userId);
  if (!user) return void refreshState().catch(() => {}); // someone we have not heard of yet
  user.online = online;
  renderSidebar();
  if (state.current?.kind === 'dm') renderHeader();
}

function onChannelCreated(channel) {
  if (!state.channels.has(channel.id)) {
    state.channels.set(channel.id, { ...channel, joined: false, muted: false, mutedUntil: null, unread: 0, mentions: 0 });
    renderSidebar();
  }
}

function onMembership({ channelId, memberCount, userId, action }) {
  const channel = state.channels.get(channelId);
  if (!channel) return;
  channel.memberCount = memberCount;
  if (userId === state.me.id) channel.joined = action === 'joined';
  renderSidebar();
  if (state.current?.id === channelId) renderHeader();
}

function applyUnread(conversationId, unread) {
  for (const channel of state.channels.values()) {
    if (channel.id === conversationId) Object.assign(channel, unread);
  }
  for (const thread of state.dms.values()) {
    if (thread.conversationId === conversationId) Object.assign(thread, unread);
  }
}

// ──────────────────────────────  rendering  ──────────────────────────────

function renderAll() {
  renderMe();
  renderSidebar();
  renderConversation();
  renderInbox();
  renderBadge();
  renderSettings();
}

function renderMe() {
  const { name, quietHoursActive } = state.me;
  $('me-name').textContent = `@${name}`;
  const avatar = $('me-avatar');
  avatar.textContent = name.slice(0, 2).toUpperCase();
  avatar.style.background = avatarColor(name);
  const status = $('me-status');
  status.textContent = quietHoursActive ? 'Quiet hours — alerts silenced' : 'Active';
  status.classList.toggle('quiet', Boolean(quietHoursActive));
}

function renderSidebar() {
  const channels = [...state.channels.values()].sort((a, b) => a.name.localeCompare(b.name));

  renderList($('channel-list'), channels.filter((c) => c.joined), (channel) => {
    const item = el('button', 'item');
    item.classList.toggle('active', state.current?.kind === 'channel' && state.current.id === channel.id);
    item.classList.toggle('unread', channel.unread > 0);
    item.append(el('span', 'sigil', '#'), el('span', 'label', channel.name));
    if (channel.muted) {
      const icon = el('span', 'mute-icon', '🔕');
      icon.title = 'Muted — unread still counts, alerts do not';
      item.append(icon);
    }
    if (channel.mentions > 0) item.append(countBadge(channel.mentions, 'mention', `${channel.mentions} mention(s)`));
    else if (channel.unread > 0) {
      item.append(countBadge(channel.unread, channel.muted ? 'plain' : 'alert', `${channel.unread} unread`));
    }
    item.onclick = () => openChannel(channel.id);
    return item;
  }, 'No channels yet — browse below.');

  const browsable = channels.filter((c) => !c.joined);
  $('browse-section').hidden = browsable.length === 0;
  renderList($('browse-list'), browsable, (channel) => {
    const item = el('button', 'item');
    item.append(el('span', 'sigil', '#'), el('span', 'label', channel.name));
    const join = el('span', 'count plain', 'Join');
    item.append(join);
    item.title = channel.topic || `${channel.memberCount} member(s)`;
    item.onclick = () => joinChannel(channel.id);
    return item;
  });

  const threads = [...state.dms.values()]
    .filter((t) => t.lastMessage)
    .sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0));
  renderList($('dm-list'), threads, (thread) => dmItem(thread.userId, thread));

  scheduleMuteTick();

  const chatted = new Set(threads.map((t) => t.userId));
  const others = [...state.users.values()].filter((u) => !chatted.has(u.id));
  renderList($('people-list'), others, (user) => dmItem(user.id, state.dms.get(user.id)),
    state.users.size === 0 ? 'Nobody else has signed in yet.' : null);
}

function dmItem(userId, thread) {
  const user = state.users.get(userId);
  const name = user?.name ?? thread?.username ?? 'unknown';
  const item = el('button', 'item');
  item.classList.toggle('active', state.current?.kind === 'dm' && state.current.id === userId);
  item.classList.toggle('unread', (thread?.unread ?? 0) > 0);
  const dot = el('span', `presence${user?.online ? ' online' : ''}`);
  item.append(dot, el('span', 'label', name));
  if (thread?.game?.yourTurn) {
    const turn = el('span', 'turn-dot', '♟');
    turn.title = 'Your move';
    item.append(turn);
  }
  if (thread?.rps?.waitingForYou) {
    const throwNow = el('span', 'turn-dot', '✊');
    throwNow.title = 'Your throw';
    item.append(throwNow);
  }
  if (thread?.unread > 0) item.append(countBadge(thread.unread, 'alert', `${thread.unread} unread`));
  item.onclick = () => openDm(userId);
  return item;
}

function countBadge(n, kind, title) {
  const badge = el('span', `count ${kind}`, String(n > 99 ? '99+' : n));
  badge.title = title ?? '';
  return badge;
}

function renderList(container, items, build, emptyText) {
  container.replaceChildren();
  if (!items.length) {
    if (emptyText) {
      const li = el('li');
      li.append(el('div', 'muted', emptyText));
      li.style.padding = '4px 8px';
      container.append(li);
    }
    return;
  }
  for (const item of items) {
    const li = el('li');
    li.append(build(item));
    container.append(li);
  }
}

function renderConversation() {
  renderHeader();
  renderMessages();
  renderScheduled();
  const hasConversation = Boolean(state.current);
  $('composer-input').disabled = !hasConversation;
  $('composer-send').disabled = !hasConversation;
}

function renderHeader() {
  // 只替换内容容器 —— 汉堡按钮是 header 的静态子元素，不能被清掉
  const header = $('header-content');
  header.replaceChildren();
  if (!state.current) {
    header.append(el('div', 'title', 'Team Chat'));
    return;
  }

  if (state.current.kind === 'channel') {
    const channel = state.channels.get(state.current.id);
    if (!channel) return;
    const title = el('div', 'title');
    title.append(el('span', 'sigil', '#'), el('span', null, channel.name));
    header.append(title);
    if (channel.topic) header.append(el('div', 'topic', channel.topic));
    header.append(el('div', 'spacer'));

    const actions = el('div', 'header-actions');
    actions.append(el('span', 'muted', `${channel.memberCount} member${channel.memberCount === 1 ? '' : 's'}`));

    const mute = el('button', `chip${channel.muted ? ' on' : ''}`, muteLabel(channel));
    mute.title = channel.muted
      ? (channel.mutedUntil
          ? `Snoozed until ${new Date(channel.mutedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : 'Muted: unread still counts; DMs and @mentions still alert you')
      : 'Mute alerts for this channel';
    mute.onclick = () => setMute(channel.id, !channel.muted);
    actions.append(mute);

    const leave = el('button', 'chip danger', 'Leave');
    leave.onclick = () => leaveChannel(channel.id);
    actions.append(leave);
    header.append(actions);
  } else {
    const user = state.users.get(state.current.id);
    const title = el('div', 'title');
    title.append(el('span', `presence${user?.online ? ' online' : ''}`), el('span', null, user?.name ?? 'unknown'));
    header.append(title);
    header.append(el('div', 'topic', 'Direct message — never muted'));
    header.append(el('div', 'spacer'));

    const thread = state.dms.get(state.current.id);
    const chess = el('button', `chip${thread?.game?.yourTurn ? ' on' : ''}`,
      thread?.game?.yourTurn ? '♟ Your move' : '♟ Chess');
    chess.title = 'Play a game of chess';
    chess.onclick = openChess;
    header.append(chess);

    const rps = el('button', `chip${thread?.rps?.waitingForYou ? ' on' : ''}`,
      thread?.rps?.waitingForYou ? '✊ Your throw' : '✊ RPS');
    rps.title = 'Rock, paper, scissors';
    rps.onclick = openRps;
    header.append(rps);

    header.append(el('span', 'muted', user?.online ? 'online' : 'offline'));
  }
}

function renderMessages() {
  const container = $('messages');
  container.replaceChildren();

  if (!state.current) {
    container.append(emptyState('Nothing open', 'Pick a channel or a person on the left.'));
    return;
  }
  const messages = state.messages.get(state.current.conversationId) ?? [];
  if (!messages.length) {
    const where = state.current.kind === 'channel'
      ? `#${state.channels.get(state.current.id)?.name ?? ''}`
      : state.users.get(state.current.id)?.name ?? '';
    container.append(emptyState('No messages yet', `Say something in ${where}.`));
    return;
  }

  const marker = state.markers.get(state.current.conversationId) ?? 0;
  let lastDay = null;
  let previous = null;
  let dividerDrawn = false;

  for (const message of messages) {
    const day = new Date(message.ts).toDateString();
    if (day !== lastDay) {
      container.append(el('div', 'day-divider', dayLabel(message.ts)));
      lastDay = day;
      previous = null;
    }
    if (!dividerDrawn && marker > 0 && message.seq > marker && message.authorId !== state.me.id) {
      container.append(el('div', 'new-divider', 'New'));
      dividerDrawn = true;
      previous = null;
    }
    container.append(messageNode(message, previous));
    previous = message;
  }
}

function messageNode(message, previous) {
  const grouped = previous
    && previous.authorId === message.authorId
    && message.ts - previous.ts < 5 * 60 * 1000;

  const node = el('div', `msg${grouped ? ' grouped' : ''}`);
  if (message.mentions.includes(state.me.id) && message.authorId !== state.me.id) {
    node.classList.add('mentions-me');
  }

  const gutter = el('div', 'gutter');
  if (grouped) {
    gutter.append(el('span', 'time', shortTime(message.ts)));
  } else {
    const avatar = el('div', 'avatar', message.authorName.slice(0, 2).toUpperCase());
    avatar.style.background = avatarColor(message.authorName);
    gutter.append(avatar);
  }
  node.append(gutter);

  const body = el('div', 'body');
  if (!grouped) {
    const meta = el('div', 'meta');
    meta.append(el('span', 'author', message.authorName), el('span', 'time', shortTime(message.ts)));
    body.append(meta);
  }
  if (message.kind === 'roll' && message.roll) {
    body.append(rollNode(message.roll));
  } else {
    const text = el('div', 'text');
    text.innerHTML = renderText(message.text);
    body.append(text);
  }
  node.append(body);
  return node;
}

/** 六面骰用骰面字形，其他面数用数字牌 —— d20 没有对应的字符。 */
const DIE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

function rollNode(roll) {
  const box = el('div', 'roll');
  const dice = el('div', 'dice');
  for (const value of roll.values) {
    dice.append(roll.sides === 6
      ? el('span', 'die', DIE_FACES[value - 1])
      : el('span', 'face', String(value)));
  }
  box.append(dice);

  if (roll.values.length > 1) {
    const total = el('span', 'total');
    total.append(document.createTextNode('= '), el('b', null, String(roll.total)));
    box.append(total);
  }
  box.append(el('span', 'notation', roll.notation));
  return box;
}

function renderText(raw) {
  const escaped = escapeHtml(raw);
  return escaped.replace(/(^|[^\w@/])@([a-z0-9][a-z0-9._-]{1,31})/gi, (match, lead, name) => {
    const trimmed = name.replace(/[.\-_]+$/, '');
    const tail = name.slice(trimmed.length);
    const known = [...state.users.values(), state.me].find((u) => u.name === trimmed.toLowerCase());
    if (!known) return match;
    const self = known.id === state.me.id ? ' self' : '';
    return `${lead}<span class="mention${self}">@${trimmed}</span>${tail}`;
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function emptyState(title, body) {
  const node = el('div', 'empty-state');
  node.append(el('h3', null, title), el('div', null, body));
  return node;
}

// ────────────────────────────  conversations  ────────────────────────────

async function openChannel(channelId) {
  const channel = state.channels.get(channelId);
  if (!channel) return;
  if (!channel.joined) return joinChannel(channelId);

  state.current = { kind: 'channel', id: channelId, conversationId: channelId };
  renderSidebar();
  renderConversation();

  const data = await api('GET', `/api/channels/${channelId}/messages`);
  state.messages.set(channelId, data.messages);
  state.markers.set(channelId, data.lastReadSeq);
  renderMessages();
  scrollToBottom();
  markCurrentRead();
  focusComposer();
}

async function openDm(userId) {
  state.game = null;
  state.rps = null;
  state.chessFrom = null;
  state.chessPromotion = null;
  const data = await api('GET', `/api/dms/${userId}/messages`);
  state.current = { kind: 'dm', id: userId, conversationId: data.conversationId };
  state.messages.set(data.conversationId, data.messages);
  state.markers.set(data.conversationId, data.lastReadSeq);
  if (!state.dms.has(userId)) {
    state.dms.set(userId, {
      conversationId: data.conversationId, userId, username: data.withUser.name,
      unread: data.unread, mentions: data.mentions, lastMessage: data.messages.at(-1) ?? null,
    });
  }
  renderSidebar();
  renderConversation();
  scrollToBottom();
  markCurrentRead();
  focusComposer();
}

async function markCurrentRead() {
  if (!state.current) return;
  const conversationId = state.current.conversationId;
  const messages = state.messages.get(conversationId) ?? [];
  const unreadNow = state.current.kind === 'channel'
    ? state.channels.get(state.current.id)?.unread ?? 0
    : state.dms.get(state.current.id)?.unread ?? 0;
  if (!unreadNow && !state.notifications.some((n) => n.conversationId === conversationId && !n.read)) return;

  const result = await api('POST', '/api/read', {
    conversationId,
    upToSeq: messages.at(-1)?.seq ?? null,
  });
  onRead({ conversationId, ...result });
}

async function joinChannel(channelId) {
  const { channel } = await api('POST', `/api/channels/${channelId}/join`);
  state.channels.set(channel.id, channel);
  renderSidebar();
  openChannel(channel.id);
}

async function leaveChannel(channelId) {
  const { channel } = await api('POST', `/api/channels/${channelId}/leave`);
  state.channels.set(channel.id, channel);
  if (state.current?.id === channelId) {
    state.current = null;
    const next = [...state.channels.values()].find((c) => c.joined);
    if (next) return openChannel(next.id);
  }
  renderSidebar();
  renderConversation();
}

async function setMute(channelId, muted, minutes = null) {
  const { channel } = await api('PATCH', `/api/channels/${channelId}/prefs`, { muted, minutes });
  state.channels.set(channel.id, channel);
  renderSidebar();
  renderHeader();
  renderSettings();
}

function muteLabel(channel) {
  if (!channel.muted) return '🔔 Mute';
  if (!channel.mutedUntil) return '🔕 Muted';
  return `🔕 ${remainingMute(channel.mutedUntil)}`;
}

function remainingMute(until) {
  const minutes = Math.max(0, Math.ceil((until - Date.now()) / 60_000));
  return minutes >= 60 ? `${Math.ceil(minutes / 60)}h` : `${minutes}m`;
}

/**
 * The server lifts a snooze by simply letting the clock pass it — nothing is
 * pushed when it lapses. So the client has to notice on its own, or the
 * sidebar keeps showing 🔕 for an hour after the mute ended.
 */
let muteTimer = null;
function scheduleMuteTick() {
  clearTimeout(muteTimer);
  const pending = [...state.channels.values()].filter((c) => c.muted && c.mutedUntil);
  if (!pending.length) return;

  const soonest = Math.min(...pending.map((c) => c.mutedUntil));
  // Wake at the expiry, or in a minute to keep the countdown honest.
  const wait = Math.min(60_000, Math.max(1000, soonest - Date.now() + 500));
  muteTimer = setTimeout(() => {
    if (soonest <= Date.now()) refreshState().catch(() => {});
    else { renderSidebar(); renderHeader(); renderSettings(); }
  }, wait);
}

// ──────────────────────────────  composer  ───────────────────────────────

const input = $('composer-input');

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  await send();
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  updateMentionPopup();
});

input.addEventListener('keydown', (event) => {
  if (mention.open) {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveMention(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveMention(-1); return; }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); acceptMention(); return; }
    if (event.key === 'Escape') { closeMentionPopup(); return; }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

async function send() {
  const text = input.value.trim();
  if (!text || !state.current) return;
  input.value = '';
  input.style.height = 'auto';
  closeMentionPopup();
  state.markers.set(state.current.conversationId, 0); // clear the "new" line once you reply

  const deliverAt = plannedTime();
  const path = state.current.kind === 'channel'
    ? `/api/channels/${state.current.id}/messages`
    : `/api/dms/${state.current.id}/messages`;

  try {
    const result = await api('POST', path, deliverAt ? { text, deliverAt } : { text });
    if (result.scheduled) {
      state.scheduled = [...state.scheduled, result.scheduled];
      clearPlannedTime();
      renderScheduled();
      flashHint(`Queued for ${whenLabel(result.scheduled.deliverAt)}.`);
    }
    scrollToBottom();
  } catch (err) {
    input.value = text;
    flashHint(err.message);
  }
}

// ──────────────────────  send later (change 2)  ─────────────────────────

/** The chosen delivery time in ms, or null for "send it now". */
function plannedTime() {
  if ($('later-row').hidden) return null;
  const value = $('later-at').value;
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

function clearPlannedTime() {
  $('later-row').hidden = true;
  $('later-at').value = '';
  $('btn-later').classList.remove('on');
}

$('btn-later').addEventListener('click', () => {
  const row = $('later-row');
  if (!row.hidden) return clearPlannedTime();
  row.hidden = false;
  $('btn-later').classList.add('on');
  // Default to an hour out, in the local time the input expects.
  const soon = new Date(Date.now() + 60 * 60_000 - new Date().getTimezoneOffset() * 60_000);
  $('later-at').value = soon.toISOString().slice(0, 16);
  $('later-at').focus();
});
$('later-clear').addEventListener('click', clearPlannedTime);

function whenLabel(at) {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function onScheduled(list) {
  state.scheduled = list;
  renderScheduled();
}

/** Only the queue for the conversation you are looking at. */
function renderScheduled() {
  const box = $('scheduled-list');
  box.replaceChildren();
  if (!state.current) return;

  const mine = state.scheduled.filter((item) => item.kind === 'channel'
    ? state.current.kind === 'channel' && item.channelId === state.current.id
    : state.current.kind === 'dm' && item.toId === state.current.id);

  for (const item of mine) {
    const row = el('div', `scheduled-item${item.status === 'failed' ? ' failed' : ''}`);
    row.append(el('span', 'when', item.status === 'failed' ? 'failed' : whenLabel(item.deliverAt)));
    row.append(el('span', 'body', item.text));
    if (item.error) row.append(el('span', 'why', item.error));

    const drop = el('button', 'chip', item.status === 'failed' ? 'Dismiss' : 'Cancel');
    drop.type = 'button';
    drop.onclick = async () => {
      try {
        await api('DELETE', `/api/scheduled/${item.id}`);
        state.scheduled = state.scheduled.filter((other) => other.id !== item.id);
        renderScheduled();
      } catch (err) { flashHint(err.message); }
    };
    row.append(drop);
    box.append(row);
  }
}

function flashHint(message) {
  const hint = $('composer-hint');
  const original = hint.textContent;
  hint.textContent = message;
  hint.style.color = 'var(--red)';
  setTimeout(() => { hint.textContent = original; hint.style.color = ''; }, 3000);
}

// ─────────────────────────  mention autocomplete  ────────────────────────

const mention = { open: false, options: [], index: 0, from: 0 };

function updateMentionPopup() {
  const upToCaret = input.value.slice(0, input.selectionStart ?? input.value.length);
  const match = /(?:^|\s)@([a-z0-9._-]*)$/i.exec(upToCaret);
  if (!match) return closeMentionPopup();

  const prefix = match[1].toLowerCase();
  const candidates = [...state.users.values()]
    .filter((u) => u.name.startsWith(prefix))
    .slice(0, 6);
  if (!candidates.length) return closeMentionPopup();

  mention.open = true;
  mention.options = candidates;
  mention.index = 0;
  mention.from = upToCaret.length - match[1].length - 1;
  drawMentionPopup();
}

function drawMentionPopup() {
  const popup = $('mention-popup');
  popup.replaceChildren();
  mention.options.forEach((user, i) => {
    const option = el('div', `mention-option${i === mention.index ? ' active' : ''}`);
    option.append(el('span', null, `@${user.name}`),
      el('span', 'who', user.online ? 'online' : 'offline'));
    option.onmousedown = (event) => { event.preventDefault(); mention.index = i; acceptMention(); };
    popup.append(option);
  });
  popup.hidden = false;
}

function moveMention(delta) {
  mention.index = (mention.index + delta + mention.options.length) % mention.options.length;
  drawMentionPopup();
}

function acceptMention() {
  const user = mention.options[mention.index];
  if (!user) return closeMentionPopup();
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, mention.from);
  const after = input.value.slice(caret);
  const insert = `@${user.name} `;
  input.value = before + insert + after;
  const position = before.length + insert.length;
  input.setSelectionRange(position, position);
  closeMentionPopup();
  input.focus();
}

function closeMentionPopup() {
  mention.open = false;
  $('mention-popup').hidden = true;
}

// ───────────────────────────────  inbox  ─────────────────────────────────

function renderBadge() {
  const unread = state.notifications.filter((n) => !n.read).length;
  const badge = $('inbox-badge');
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.hidden = unread === 0;
}

function renderInbox() {
  const list = $('inbox-list');
  list.replaceChildren();
  if (!state.notifications.length) {
    list.append(emptyState('All quiet', 'Direct messages and @mentions show up here.'));
    return;
  }

  for (const notification of state.notifications) {
    const item = el('button', `notif${notification.read ? '' : ' unread'}`);

    const head = el('div', 'head');
    head.append(el('span', 'who', `@${notification.from.name}`));
    head.append(el('span', 'where', notification.channel ? `in #${notification.channel.name}` : 'direct message'));
    head.append(el('span', 'when', shortTime(notification.ts)));
    item.append(head);

    item.append(el('div', 'preview', notification.preview));

    if (notification.kind === 'digest' && notification.items?.length) {
      const items = el('div', 'digest-items');
      for (const entry of notification.items) {
        const row = el('div', 'digest-item');
        row.append(el('span', 'who', `@${entry.from.name}`));
        row.append(el('span', 'what', `${entry.channel ? `#${entry.channel.name} · ` : ''}${entry.preview}`));
        items.append(row);
      }
      item.append(items);
    }

    const why = el('div', 'why');
    const tagFor = { direct: ['dm', 'DM'], mention: ['mention', 'Mention'], digest: ['digest', 'Digest'] };
    const [tagClass, tagText] = tagFor[notification.kind] ?? ['mention', 'Mention'];
    why.append(el('span', `tag ${tagClass}`, tagText));
    if (notification.bypassedMute) why.append(el('span', 'tag bypass', 'Bypassed mute'));
    if (notification.silencedByQuietHours) why.append(el('span', 'tag quiet', 'Quiet hours'));
    why.append(el('span', null, notification.reason));
    item.append(why);

    item.onclick = () => {
      closePanels();
      const target = notification.kind === 'digest' ? notification.items?.[0] : notification;
      if (!target) return;
      if (target.channel) openChannel(target.channel.id);
      else if (target.from?.id) openDm(target.from.id);
    };
    list.append(item);
  }
}

$('btn-read-all').addEventListener('click', async () => {
  await api('POST', '/api/notifications/read', {});
  for (const n of state.notifications) n.read = true;
  renderInbox();
  renderBadge();
});

// ──────────────────────────────  settings  ───────────────────────────────

function renderSettings() {
  const qh = state.me.prefs.quietHours;
  $('qh-enabled').checked = qh.enabled;
  $('qh-start').value = qh.start;
  $('qh-end').value = qh.end;
  $('qh-allow-direct').checked = qh.allowDirect;

  const status = $('qh-status');
  if (!qh.enabled) {
    status.textContent = 'Quiet hours are off — everything alerts normally.';
    status.classList.remove('active');
  } else if (state.me.quietHoursActive) {
    status.textContent = `Quiet hours are active right now (${qh.start}–${qh.end}). `
      + (qh.allowDirect ? 'Direct messages still ring.' : 'Alerts are silenced; the inbox still fills up.');
    status.classList.add('active');
  } else {
    status.textContent = `Scheduled ${qh.start}–${qh.end}. Not active right now.`;
    status.classList.remove('active');
  }

  const digest = state.me.prefs.digest ?? { enabled: false, everyMinutes: 60 };
  $('digest-enabled').checked = digest.enabled;
  $('digest-every').value = digest.everyMinutes;
  $('digest-every').disabled = !digest.enabled;
  $('digest-status').textContent = digest.enabled
    ? `Mentions are held and delivered together every ${digest.everyMinutes} minutes. Direct messages still come straight through.`
    : 'Off — every mention notifies you as it happens.';

  const list = $('mute-list');
  list.replaceChildren();
  const joined = [...state.channels.values()].filter((c) => c.joined).sort((a, b) => a.name.localeCompare(b.name));
  if (!joined.length) {
    const li = el('li');
    li.append(el('span', 'muted', 'Join a channel to configure its mute.'));
    list.append(li);
    return;
  }
  for (const channel of joined) {
    const li = el('li');
    li.append(el('span', 'label', `#${channel.name}`));
    if (channel.muted) {
      li.append(el('span', 'muted-note', channel.mutedUntil
        ? `until ${new Date(channel.mutedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : `${channel.unread} unread, silent`));
    } else {
      const snooze = el('button', 'snooze-btn', '1h');
      snooze.type = 'button';
      snooze.title = 'Mute for one hour, then unmute itself';
      snooze.onclick = () => setMute(channel.id, true, 60);
      li.append(snooze);
    }
    const label = el('label', 'switch');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = channel.muted;
    box.onchange = () => setMute(channel.id, box.checked);
    label.append(box, el('span', null, 'Mute'));
    li.append(label);
    list.append(li);
  }
}

async function saveQuietHours() {
  const { quietHours, active } = await api('PATCH', '/api/settings/quiet-hours', {
    enabled: $('qh-enabled').checked,
    start: $('qh-start').value || '22:00',
    end: $('qh-end').value || '08:00',
    allowDirect: $('qh-allow-direct').checked,
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
  });
  state.me.prefs.quietHours = quietHours;
  state.me.quietHoursActive = active;
  renderMe();
  renderSettings();
}

for (const id of ['qh-enabled', 'qh-start', 'qh-end', 'qh-allow-direct']) {
  $(id).addEventListener('change', saveQuietHours);
}

async function saveDigest() {
  const { digest } = await api('PATCH', '/api/settings/digest', {
    enabled: $('digest-enabled').checked,
    everyMinutes: Number($('digest-every').value) || 60,
  });
  state.me.prefs.digest = digest;
  renderSettings();
  renderInbox();
  renderBadge();
}

for (const id of ['digest-enabled', 'digest-every']) {
  $(id).addEventListener('change', saveDigest);
}

// ─────────────────────────  panels, dialogs, toasts  ─────────────────────

/**
 * 窄屏下侧边栏是浮层。桌面端 CSS 里它常驻，这个开关不起作用。
 */
const isNarrow = () => window.matchMedia('(max-width: 720px)').matches;

function setSidebar(open) {
  $('app').classList.toggle('show-sidebar', open);
  $('btn-menu').setAttribute('aria-expanded', String(open));
}

$('btn-menu').addEventListener('click', () => {
  setSidebar(!$('app').classList.contains('show-sidebar'));
});
$('sidebar-backdrop').addEventListener('click', () => setSidebar(false));

function openPanel(id) {
  closePanels();
  setSidebar(false);
  $(id).hidden = false;
  $('scrim').hidden = false;
}
function closePanels() {
  $('inbox-panel').hidden = true;
  $('settings-panel').hidden = true;
  $('chess-panel').hidden = true;
  $('rps-panel').hidden = true;
  $('scrim').hidden = true;
}
$('scrim').addEventListener('click', closePanels);
for (const button of document.querySelectorAll('[data-close-panel]')) {
  button.addEventListener('click', closePanels);
}
$('btn-inbox').addEventListener('click', () => { renderInbox(); openPanel('inbox-panel'); });
$('btn-settings').addEventListener('click', () => { renderSettings(); openPanel('settings-panel'); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closePanels();
  setSidebar(false);
});

const dialog = $('new-channel-dialog');
$('btn-new-channel').addEventListener('click', () => {
  $('new-channel-name').value = '';
  $('new-channel-topic').value = '';
  $('new-channel-error').hidden = true;
  dialog.showModal();
  $('new-channel-name').focus();
});
$('new-channel-cancel').addEventListener('click', () => dialog.close());
$('new-channel-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('new-channel-error');
  try {
    const { channel } = await api('POST', '/api/channels', {
      name: $('new-channel-name').value,
      topic: $('new-channel-topic').value,
    });
    state.channels.set(channel.id, channel);
    dialog.close();
    renderSidebar();
    openChannel(channel.id);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

function showToast(notification) {
  const toast = el('div', `toast${notification.kind === 'mention' ? ' mention' : ''}`);
  const head = el('div', 'head');
  head.append(document.createTextNode(notification.kind === 'direct' ? 'DM from ' : 'Mentioned by '));
  head.append(el('strong', null, `@${notification.from.name}`));
  if (notification.channel) head.append(document.createTextNode(` in #${notification.channel.name}`));
  if (notification.bypassedMute) head.append(document.createTextNode(' · muted channel'));
  toast.append(head, el('div', 'preview', notification.preview));

  toast.onclick = () => {
    toast.remove();
    if (notification.channel) openChannel(notification.channel.id);
    else openDm(notification.from.id);
  };
  $('toasts').append(toast);
  setTimeout(() => toast.remove(), 6000);
}

// ────────────────────────────────  chess  ────────────────────────────────

/**
 * 棋规完全在服务端。客户端只画服务端给的 64 格，并且只允许服务端
 * 明确列为合法的走法 —— 这里没有引擎，也不需要有。
 */
const PIECE_GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const pieceColor = (piece) => (piece === piece.toUpperCase() ? 'w' : 'b');

async function openChess() {
  if (state.current?.kind !== 'dm') return;
  const thread = state.dms.get(state.current.id);
  state.chessFrom = null;
  state.chessPromotion = null;

  if (thread?.game?.id && state.game?.id !== thread.game.id) {
    try {
      state.game = (await api('GET', `/api/games/${thread.game.id}`)).game;
    } catch { state.game = null; }
  }
  renderChess();
  openPanel('chess-panel');
}

function onGame(game) {
  const thread = [...state.dms.values()].find((t) => t.conversationId === game.conversationId);
  if (!thread) {
    // 对方刚发起挑战，这个私信线程本地还不存在
    refreshState().catch(() => {});
    return;
  }
  const open = state.current?.kind === 'dm' && state.current.conversationId === game.conversationId;
  const live = game.status !== 'finished';

  if (game.kind === 'rps') {
    thread.rps = live ? { id: game.id, status: game.status, waitingForYou: game.waitingForYou } : null;
    if (open) {
      state.rps = game;
      renderRps();
    }
  } else {
    thread.game = live
      ? { id: game.id, status: game.status, yourTurn: game.yourTurn, yourColor: game.yourColor }
      : null;
    if (open) {
      state.game = game;
      state.chessFrom = null;
      state.chessPromotion = null;
      renderChess();
    }
  }

  renderSidebar();
  if (state.current?.kind === 'dm') renderHeader();
}

function renderChess() {
  const body = $('chess-body');
  body.replaceChildren();

  if (state.current?.kind !== 'dm') {
    body.append(emptyState('Chess', 'Open a direct message to play someone.'));
    return;
  }

  const opponent = state.users.get(state.current.id);
  const name = opponent?.name ?? 'them';
  const game = state.game;

  if (!game) {
    body.append(emptyState('No game yet', `Challenge @${name} to a game of chess.`));
    body.append(actions([['Challenge ' + name, 'primary', challengeOpponent]]));
    return;
  }

  if (game.status === 'pending') {
    const yours = game.createdBy === state.me.id;
    const color = game.yourColor === 'w' ? 'white' : 'black';
    body.append(el('p', 'chess-empty', yours
      ? `Waiting for @${name} to accept. You drew ${color}.`
      : `@${name} challenged you. You play ${color}.`));
    body.append(actions(yours
      ? [['Cancel', '', () => gameAction('decline')]]
      : [['Accept', 'primary', () => gameAction('accept')], ['Decline', '', () => gameAction('decline')]]));
    return;
  }

  const wrap = el('div', 'chess');
  wrap.append(seats(game));
  if (state.chessPromotion) wrap.append(promotionPicker());
  wrap.append(boardNode(game));
  wrap.append(statusLine(game, name));
  if (game.moves.length) wrap.append(moveList(game));

  wrap.append(actions(game.status === 'finished'
    ? [['New game', 'primary', challengeOpponent]]
    : [['Resign', '', () => { if (confirm('Resign this game?')) gameAction('resign'); }]]));

  body.append(wrap);
}

function seats(game) {
  const box = el('div', 'chess-players');
  for (const color of ['w', 'b']) {
    const player = color === 'w' ? game.white : game.black;
    const seat = el('div', `chess-seat${game.status === 'active' && game.turn === color ? ' turn' : ''}`);
    seat.append(el('span', `swatch ${color}`), el('span', 'who', player.name));
    if (player.id === state.me.id) seat.append(el('span', 'you', 'you'));
    box.append(seat);
  }
  return box;
}

function boardNode(game) {
  const flipped = game.yourColor === 'b';
  const board = el('div', 'board');

  const targets = new Map();
  if (game.yourTurn && state.chessFrom != null) {
    for (const move of game.legalMoves) {
      if (move.from !== state.chessFrom) continue;
      if (!targets.has(move.to)) targets.set(move.to, []);
      targets.get(move.to).push(move);
    }
  }
  const movable = new Set(game.legalMoves.map((move) => move.from));

  for (let i = 0; i < 64; i++) {
    const index = flipped ? 63 - i : i;
    const file = index % 8;
    const rank = (index / 8) | 0;
    const square = el('button', `sq ${(file + rank) % 2 === 0 ? 'light' : 'dark'}`);
    square.type = 'button';

    const piece = game.board[index];
    if (piece !== '.') {
      square.append(el('span', `piece ${pieceColor(piece)}`, PIECE_GLYPH[piece.toLowerCase()]));
      if (game.check && piece.toLowerCase() === 'k' && pieceColor(piece) === game.turn) {
        square.classList.add('check');
      }
    }
    if (game.lastMove && (index === game.lastMove.from || index === game.lastMove.to)) {
      square.classList.add('last');
    }
    if (index === state.chessFrom) square.classList.add('selected');
    if (targets.has(index)) {
      square.classList.add('playable');
      if (piece !== '.') square.classList.add('capture');
      square.append(el('span', 'hint'));
    } else if (movable.has(index)) {
      square.classList.add('playable');
    }

    square.onclick = () => onSquare(index, targets);
    board.append(square);
  }
  return board;
}

function onSquare(index, targets) {
  const game = state.game;
  if (!game || !game.yourTurn) return;

  const moves = targets.get(index);
  if (moves?.length) {
    // 升变时同一个目标格有四种走法，得先问清楚变成什么
    if (moves.some((move) => move.promotion)) {
      state.chessPromotion = { from: state.chessFrom, to: index };
      renderChess();
      return;
    }
    submitMove(state.chessFrom, index, null);
    return;
  }

  state.chessFrom = game.legalMoves.some((move) => move.from === index) ? index : null;
  state.chessPromotion = null;
  renderChess();
}

function promotionPicker() {
  const box = el('div', 'promotion');
  box.append(el('span', 'label', 'Promote to'));
  for (const piece of ['q', 'r', 'b', 'n']) {
    const button = el('button', null, PIECE_GLYPH[piece]);
    button.type = 'button';
    button.title = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[piece];
    button.onclick = () => submitMove(state.chessPromotion.from, state.chessPromotion.to, piece);
    box.append(button);
  }
  return box;
}

function statusLine(game, name) {
  if (game.status === 'finished') {
    return el('div', 'chess-status over', describeGameResult(game, name));
  }
  const check = game.check ? ' — check' : '';
  return game.yourTurn
    ? el('div', 'chess-status your-turn', `Your move${check}.`)
    : el('div', 'chess-status', `Waiting for @${name}${check}.`);
}

function describeGameResult(game, name) {
  const result = game.result ?? {};
  if (result.state === 'declined') return 'The challenge was declined.';
  if (result.state === 'stalemate') return 'Stalemate — a draw.';
  if (result.state === 'draw') return `Draw by ${String(result.reason).replace(/-/g, ' ')}.`;
  if (result.state === 'resigned') {
    return result.by === state.me.id ? 'You resigned.' : `@${name} resigned — you win.`;
  }
  if (result.state === 'checkmate') {
    return result.winner === game.yourColor ? 'Checkmate — you win.' : 'Checkmate — you lose.';
  }
  return 'Game over.';
}

function moveList(game) {
  const box = el('div', 'chess-moves');
  game.moves.forEach((move, index) => {
    if (index % 2 === 0) box.append(el('span', 'no', `${index / 2 + 1}.`));
    box.append(el('span', 'san', move.san));
  });
  box.scrollTop = box.scrollHeight;
  return box;
}

function actions(buttons) {
  const row = el('div', 'chess-actions');
  for (const [label, className, onClick] of buttons) {
    const button = el('button', className || 'chip', label);
    button.type = 'button';
    button.onclick = onClick;
    row.append(button);
  }
  return row;
}

async function submitMove(from, to, promotion) {
  state.chessFrom = null;
  state.chessPromotion = null;
  try {
    state.game = (await api('POST', `/api/games/${state.game.id}/moves`, { from, to, promotion })).game;
  } catch (err) {
    flashChess(err.message);
  }
  renderChess();
}

async function challengeOpponent() {
  try {
    state.game = (await api('POST', '/api/games', { opponentId: state.current.id })).game;
    renderChess();
  } catch (err) {
    flashChess(err.message);
  }
}

async function gameAction(action) {
  try {
    state.game = (await api('POST', `/api/games/${state.game.id}/${action}`)).game;
    if (action === 'decline') state.game = null;
    renderChess();
  } catch (err) {
    flashChess(err.message);
  }
}

function flashChess(message) {
  const body = $('chess-body');
  const note = el('div', 'chess-status', message);
  note.style.borderColor = 'var(--red)';
  body.prepend(note);
  setTimeout(() => note.remove(), 3500);
}

// ─────────────────────  rock, paper, scissors  ───────────────────────────

const HAND = { rock: '✊', paper: '✋', scissors: '✌️' };

async function openRps() {
  if (state.current?.kind !== 'dm') return;
  const thread = state.dms.get(state.current.id);

  if (thread?.rps?.id && state.rps?.id !== thread.rps.id) {
    try {
      state.rps = (await api('GET', `/api/games/${thread.rps.id}`)).game;
    } catch { state.rps = null; }
  }
  renderRps();
  openPanel('rps-panel');
}

function renderRps() {
  const body = $('rps-body');
  body.replaceChildren();

  if (state.current?.kind !== 'dm') {
    body.append(emptyState('Rock, paper, scissors', 'Open a direct message to play someone.'));
    return;
  }

  const name = state.users.get(state.current.id)?.name ?? 'them';
  const game = state.rps;

  if (!game) {
    body.append(emptyState('No match yet', `Play @${name} — first to two wins.`));
    body.append(actions([[`Play ${name}`, 'primary', startRpsMatch]]));
    return;
  }

  const wrap = el('div', 'rps');
  wrap.append(rpsScore(game, name));

  const done = game.status === 'finished';
  const last = game.rounds.at(-1) ?? null;

  if (game.yourThrow || done) {
    // 自己出过之后就把手亮出来；对方那只在双方都出完之前一直是问号
    wrap.append(rpsReveal(game, last, done));
  }

  if (!done && game.waitingForYou) {
    const row = el('div', 'rps-throws');
    for (const choice of ['rock', 'paper', 'scissors']) {
      const button = el('button', null, HAND[choice]);
      button.type = 'button';
      button.title = choice;
      button.setAttribute('aria-label', choice);
      button.onclick = () => throwHand(choice);
      row.append(button);
    }
    wrap.append(row);
  }

  wrap.append(rpsStatus(game, name, done));
  if (game.rounds.length) wrap.append(rpsRounds(game));
  wrap.append(actions(done ? [['Play again', 'primary', startRpsMatch]] : []));

  body.append(wrap);
}

function rpsScore(game, name) {
  const box = el('div', 'rps-score');
  const mine = el('div', `side${game.yourScore > game.opponentScore ? ' leading' : ''}`);
  mine.append(el('div', 'name', 'you'), el('div', 'wins', String(game.yourScore)));
  const theirs = el('div', `side${game.opponentScore > game.yourScore ? ' leading' : ''}`);
  theirs.append(el('div', 'name', name), el('div', 'wins', String(game.opponentScore)));

  const middle = el('div', 'side');
  middle.append(el('div', 'dash', '—'), el('div', 'target', `first to ${game.target}`));

  box.append(mine, middle, theirs);
  return box;
}

function rpsReveal(game, last, done) {
  const box = el('div', 'rps-reveal');
  const revealed = Boolean(last) && !game.yourThrow;

  const mine = revealed || done ? HAND[last?.yours] ?? '·' : HAND[game.yourThrow] ?? '·';
  box.append(el('div', 'hand', mine));
  box.append(el('div', 'vs', 'vs'));

  if (revealed || done) {
    box.append(el('div', 'hand', HAND[last?.theirs] ?? '·'));
  } else {
    const hidden = el('div', 'hand hidden', game.opponentHasThrown ? '✊' : '·');
    hidden.title = game.opponentHasThrown ? 'They have thrown — hidden until you do' : 'They have not thrown yet';
    box.append(hidden);
  }
  return box;
}

function rpsStatus(game, name, done) {
  if (done) {
    const result = game.result ?? {};
    const won = result.winner === game.you.id;
    const line = result.state === 'resigned'
      ? (result.by === state.me.id ? 'You gave it up.' : `@${name} gave it up — you win.`)
      : `${won ? 'You win' : 'You lose'} ${game.yourScore}–${game.opponentScore}.`;
    return el('div', 'rps-status over', line);
  }
  if (game.waitingForYou) {
    return el('div', 'rps-status waiting',
      game.opponentHasThrown ? `@${name} has thrown. Your turn — they cannot see it either.` : 'Pick one.');
  }
  return el('div', 'rps-status', `You threw ${HAND[game.yourThrow]}. Waiting for @${name}.`);
}

function rpsRounds(game) {
  const box = el('div', 'rps-rounds');
  game.rounds.forEach((round, index) => {
    const row = el('div', `round ${round.outcome}`);
    row.append(el('span', 'no', `R${index + 1}`));
    row.append(el('span', 'hands', `${HAND[round.yours]} vs ${HAND[round.theirs]}`));
    row.append(el('span', 'outcome', { win: 'won', loss: 'lost', tie: 'tie' }[round.outcome]));
    box.append(row);
  });
  return box;
}

async function throwHand(choice) {
  try {
    state.rps = (await api('POST', `/api/games/${state.rps.id}/throw`, { choice })).game;
  } catch (err) {
    flashRps(err.message);
  }
  renderRps();
}

async function startRpsMatch() {
  try {
    state.rps = (await api('POST', '/api/games', { opponentId: state.current.id, kind: 'rps' })).game;
    renderRps();
  } catch (err) {
    flashRps(err.message);
  }
}

function flashRps(message) {
  const note = el('div', 'rps-status', message);
  note.style.borderColor = 'var(--red)';
  $('rps-body').prepend(note);
  setTimeout(() => note.remove(), 3500);
}

/** A short, quiet blip. Silently does nothing if audio is unavailable. */
let audio = null;
function beep(higher) {
  try {
    audio ??= new (window.AudioContext ?? window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = higher ? 880 : 660;
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.05, audio.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.2);
  } catch { /* no audio, no problem */ }
}

// ──────────────────────────────  helpers  ────────────────────────────────

/** 打开会话后：收起浮层侧边栏，桌面端才把焦点给输入框。 */
function focusComposer() {
  setSidebar(false);
  if (!isNarrow()) $('composer-input').focus();
}

function isScrolledToBottom() {
  const box = $('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}
function scrollToBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function shortTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function dayLabel(ts) {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function avatarColor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash} 55% 42%)`;
}

window.addEventListener('focus', () => { markCurrentRead().catch(() => {}); });

boot();
