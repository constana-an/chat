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
  current: null,               // {kind:'channel'|'dm', id, conversationId}
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

function onPrefs({ channels, quietHours }) {
  if (channels) state.channels = new Map(channels.map((c) => [c.id, c]));
  if (quietHours) state.me.prefs.quietHours = quietHours;
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
    state.channels.set(channel.id, { ...channel, joined: false, muted: false, unread: 0, mentions: 0 });
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

    const mute = el('button', `chip${channel.muted ? ' on' : ''}`, channel.muted ? '🔕 Muted' : '🔔 Mute');
    mute.title = channel.muted
      ? 'Muted: unread still counts; DMs and @mentions still alert you'
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
  const text = el('div', 'text');
  text.innerHTML = renderText(message.text);
  body.append(text);
  node.append(body);
  return node;
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

async function setMute(channelId, muted) {
  const { channel } = await api('PATCH', `/api/channels/${channelId}/prefs`, { muted });
  state.channels.set(channel.id, channel);
  renderSidebar();
  renderHeader();
  renderSettings();
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

  try {
    if (state.current.kind === 'channel') {
      await api('POST', `/api/channels/${state.current.id}/messages`, { text });
    } else {
      await api('POST', `/api/dms/${state.current.id}/messages`, { text });
    }
    scrollToBottom();
  } catch (err) {
    input.value = text;
    flashHint(err.message);
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

    const why = el('div', 'why');
    why.append(el('span', `tag ${notification.kind === 'direct' ? 'dm' : 'mention'}`,
      notification.kind === 'direct' ? 'DM' : 'Mention'));
    if (notification.bypassedMute) why.append(el('span', 'tag bypass', 'Bypassed mute'));
    if (notification.silencedByQuietHours) why.append(el('span', 'tag quiet', 'Quiet hours'));
    why.append(el('span', null, notification.reason));
    item.append(why);

    item.onclick = () => {
      closePanels();
      if (notification.channel) openChannel(notification.channel.id);
      else openDm(notification.from.id);
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
    if (channel.muted) li.append(el('span', 'muted-note', `${channel.unread} unread, silent`));
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
