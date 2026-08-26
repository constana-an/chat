/**
 * In-memory data store with optional JSON persistence.
 *
 * Everything is keyed off a single monotonically increasing `seq`, which is
 * what makes unread counts cheap: a read cursor is just "the highest seq I
 * have seen in this conversation".
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DEFAULT_QUIET_HOURS,
  USERNAME_RE,
  parseMentions,
  sanitizeQuietHours,
} from './notifications.js';

const scrypt = promisify(crypto.scrypt);

/** Keep memory bounded; history older than this is dropped per conversation. */
const MAX_HISTORY = 500;

/**
 * Password hashing. scrypt is memory-hard, so a stolen db.json is expensive to
 * attack offline -- and slow enough (~100ms) that online guessing needs the
 * throttle below to stay honest.
 */
const SCRYPT = { N: 65536, r: 8, p: 1, keylen: 64 };

/** scrypt needs 128 * N * r bytes; Node's default cap of 32 MB is below ours. */
const scryptOptions = ({ N, r, p }) => ({ N, r, p, maxmem: 256 * 1024 * 1024 });
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

/** After this many wrong passwords for one username, back off exponentially. */
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_LOCK_MAX_MS = 5 * 60 * 1000;

const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

export function createStore({ dataFile = null, seedDemo = true } = {}) {
  const state = {
    seq: 0,
    users: new Map(),        // userId -> user
    usersByName: new Map(),  // lowercase name -> userId
    sessions: new Map(),     // token -> userId
    channels: new Map(),     // channelId -> channel
    conversations: new Map(),// conversationId -> {id, kind, messages: []}
    reads: new Map(),        // `${userId}|${conversationId}` -> seq
    notifications: new Map(),// userId -> notification[]
    online: new Map(),       // userId -> connection count
    loginFailures: new Map(),// username -> {count, until} -- deliberately not persisted
  };

  let saveTimer = null;

  // ---------------------------------------------------------------- persistence

  function load() {
    if (!dataFile || !fs.existsSync(dataFile)) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      state.seq = raw.seq ?? 0;
      for (const u of raw.users ?? []) {
        const user = {
          ...u,
          channels: new Set(u.channels ?? []),
          prefs: {
            mutedChannels: new Set(u.prefs?.mutedChannels ?? []),
            quietHours: { ...DEFAULT_QUIET_HOURS, ...(u.prefs?.quietHours ?? {}) },
          },
        };
        state.users.set(user.id, user);
        state.usersByName.set(user.name, user.id);
      }
      for (const c of raw.channels ?? []) {
        state.channels.set(c.id, { ...c, members: new Set(c.members ?? []) });
      }
      for (const c of raw.conversations ?? []) state.conversations.set(c.id, c);
      for (const [k, v] of Object.entries(raw.reads ?? {})) state.reads.set(k, v);
      for (const [k, v] of Object.entries(raw.notifications ?? {})) state.notifications.set(k, v);
      return true;
    } catch (err) {
      console.warn(`[store] could not read ${dataFile}: ${err.message} — starting fresh`);
      return false;
    }
  }

  function snapshot() {
    return {
      seq: state.seq,
      users: [...state.users.values()].map((u) => ({
        ...u,
        channels: [...u.channels],
        prefs: { mutedChannels: [...u.prefs.mutedChannels], quietHours: u.prefs.quietHours },
      })),
      channels: [...state.channels.values()].map((c) => ({ ...c, members: [...c.members] })),
      conversations: [...state.conversations.values()],
      reads: Object.fromEntries(state.reads),
      notifications: Object.fromEntries(state.notifications),
    };
  }

  function save() {
    if (!dataFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(dataFile), { recursive: true });
        fs.writeFileSync(dataFile, JSON.stringify(snapshot(), null, 2), { mode: 0o600 });
        // writeFileSync only applies `mode` when creating, so re-assert it.
        fs.chmodSync(dataFile, 0o600);
      } catch (err) {
        console.warn(`[store] could not write ${dataFile}: ${err.message}`);
      }
    }, 250).unref?.();
  }

  // ---------------------------------------------------------------------- users

  function createUser(rawName) {
    const name = String(rawName ?? '').trim().toLowerCase();
    if (!USERNAME_RE.test(name)) {
      throw httpError(400, 'Usernames are 2–32 characters: letters, numbers, dot, dash, underscore.');
    }
    const existing = state.usersByName.get(name);
    if (existing) return state.users.get(existing);

    const user = {
      id: id('u'),
      name,
      createdAt: Date.now(),
      channels: new Set(),
      prefs: { mutedChannels: new Set(), quietHours: { ...DEFAULT_QUIET_HOURS } },
    };
    state.users.set(user.id, user);
    state.usersByName.set(name, user.id);

    // New members land in the default channels so the app is never empty.
    for (const channel of state.channels.values()) {
      if (channel.isDefault) joinChannel(user.id, channel.id);
    }
    save();
    return user;
  }

  const getUser = (userId) => state.users.get(userId);
  const getUserByName = (name) => state.users.get(state.usersByName.get(String(name).toLowerCase()));
  const listUsers = () => [...state.users.values()].sort((a, b) => a.name.localeCompare(b.name));

  // ---------------------------------------------------------------------- auth

  function assertPassword(password) {
    const value = String(password ?? '');
    if (value.length < MIN_PASSWORD) {
      throw httpError(400, `Passwords need at least ${MIN_PASSWORD} characters.`);
    }
    if (value.length > MAX_PASSWORD) {
      throw httpError(400, `Passwords are at most ${MAX_PASSWORD} characters.`);
    }
    return value;
  }

  async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = await scrypt(password, salt, SCRYPT.keylen, scryptOptions(SCRYPT));
    return {
      algo: 'scrypt',
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      salt: salt.toString('base64'),
      hash: derived.toString('base64'),
    };
  }

  async function passwordMatches(auth, password) {
    if (!auth?.hash || !auth?.salt) return false;
    const expected = Buffer.from(auth.hash, 'base64');
    // Read the cost from the record, not the constant, so hashes written by an
    // older (or newer) setting still verify.
    const derived = await scrypt(password, Buffer.from(auth.salt, 'base64'), expected.length,
      scryptOptions({ N: auth.N ?? SCRYPT.N, r: auth.r ?? SCRYPT.r, p: auth.p ?? SCRYPT.p }));
    // Constant-time: a fast "no" would leak how much of the hash matched.
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  }

  /** Milliseconds left on a username's lockout, or 0 if it is free to try. */
  function loginLockRemaining(name, now = Date.now()) {
    const record = state.loginFailures.get(name);
    if (!record) return 0;
    return Math.max(0, record.until - now);
  }

  function recordFailedLogin(name, now = Date.now()) {
    const record = state.loginFailures.get(name) ?? { count: 0, until: 0 };
    record.count++;
    if (record.count >= LOGIN_ATTEMPT_LIMIT) {
      const over = record.count - LOGIN_ATTEMPT_LIMIT;
      record.until = now + Math.min(2 ** over * 1000, LOGIN_LOCK_MAX_MS);
    }
    state.loginFailures.set(name, record);
    return record;
  }

  /**
   * Sign in, or register on first use of a name.
   *
   * An account created before passwords existed has no `auth`; the first login
   * claims it by setting one. That is the only sane upgrade path for existing
   * data, but it does mean whoever logs in first owns the name -- the server
   * warns about such accounts at startup.
   */
  async function authenticate({ username, password }) {
    const name = String(username ?? '').trim().toLowerCase();
    if (!USERNAME_RE.test(name)) {
      throw httpError(400, 'Usernames are 2–32 characters: letters, numbers, dot, dash, underscore.');
    }
    const secret = assertPassword(password);

    const lockedFor = loginLockRemaining(name);
    if (lockedFor > 0) {
      throw httpError(429, `Too many failed attempts. Try again in ${Math.ceil(lockedFor / 1000)}s.`);
    }

    const existing = getUserByName(name);

    if (!existing) {
      const user = createUser(name);
      user.auth = await hashPassword(secret);
      save();
      return { user, created: true, claimed: false };
    }

    if (!existing.auth) {
      existing.auth = await hashPassword(secret);
      save();
      return { user: existing, created: false, claimed: true };
    }

    if (!(await passwordMatches(existing.auth, secret))) {
      recordFailedLogin(name);
      throw httpError(401, 'That username is taken and the password does not match.');
    }

    state.loginFailures.delete(name);
    return { user: existing, created: false, claimed: false };
  }

  /** Accounts that predate passwords, so the server can warn about them. */
  const unclaimedAccounts = () =>
    [...state.users.values()].filter((u) => !u.auth).map((u) => u.name);

  // ------------------------------------------------------------------ sessions

  function createSession(userId) {
    const token = crypto.randomBytes(24).toString('base64url');
    state.sessions.set(token, userId);
    return token;
  }
  const userForToken = (token) => state.users.get(state.sessions.get(token));
  const destroySession = (token) => state.sessions.delete(token);

  // ------------------------------------------------------------------ channels

  function createChannel({ name, topic = '', createdBy = null, isDefault = false }) {
    const clean = String(name ?? '').trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
    if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(clean)) {
      throw httpError(400, 'Channel names are 2–32 characters: letters, numbers, dot, dash, underscore.');
    }
    for (const channel of state.channels.values()) {
      if (channel.name === clean) throw httpError(409, `#${clean} already exists.`);
    }
    const channel = {
      id: id('ch'),
      name: clean,
      topic: String(topic ?? '').slice(0, 200),
      createdBy,
      createdAt: Date.now(),
      isDefault,
      members: new Set(),
    };
    state.channels.set(channel.id, channel);
    state.conversations.set(channel.id, { id: channel.id, kind: 'channel', messages: [] });
    if (createdBy) joinChannel(createdBy, channel.id);
    save();
    return channel;
  }

  const getChannel = (channelId) => state.channels.get(channelId);
  const listChannels = () => [...state.channels.values()].sort((a, b) => a.name.localeCompare(b.name));

  function joinChannel(userId, channelId) {
    const user = mustUser(userId);
    const channel = mustChannel(channelId);
    if (!channel.members.has(userId)) {
      channel.members.add(userId);
      user.channels.add(channelId);
      // Joining is not "catching up on everything said before you arrived".
      state.reads.set(readKey(userId, channelId), state.seq);
      save();
    }
    return channel;
  }

  function leaveChannel(userId, channelId) {
    const user = mustUser(userId);
    const channel = mustChannel(channelId);
    channel.members.delete(userId);
    user.channels.delete(channelId);
    user.prefs.mutedChannels.delete(channelId);
    state.reads.delete(readKey(userId, channelId));
    save();
    return channel;
  }

  // --------------------------------------------------------------- direct msgs

  /** Stable id for a pair of users, independent of who started the thread. */
  function dmConversationId(a, b) {
    return `dm_${[a, b].sort().join('_')}`;
  }

  function ensureDmConversation(a, b) {
    const cid = dmConversationId(a, b);
    if (!state.conversations.has(cid)) {
      state.conversations.set(cid, { id: cid, kind: 'direct', participants: [a, b].sort(), messages: [] });
    }
    return state.conversations.get(cid);
  }

  function listDmThreads(userId) {
    const threads = [];
    for (const conversation of state.conversations.values()) {
      if (conversation.kind !== 'direct') continue;
      if (!conversation.participants.includes(userId)) continue;
      const otherId = conversation.participants.find((p) => p !== userId) ?? userId;
      const last = conversation.messages.at(-1) ?? null;
      threads.push({
        conversationId: conversation.id,
        userId: otherId,
        username: getUser(otherId)?.name ?? 'unknown',
        lastMessage: last ? publicMessage(last) : null,
        ...unreadFor(userId, conversation.id),
      });
    }
    return threads.sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0));
  }

  // ------------------------------------------------------------------ messages

  function appendMessage(conversation, { authorId, text, mentions }) {
    const message = {
      id: id('m'),
      seq: ++state.seq,
      conversationId: conversation.id,
      scope: conversation.kind,
      authorId,
      authorName: getUser(authorId)?.name ?? 'unknown',
      text,
      mentions,
      ts: Date.now(),
    };
    conversation.messages.push(message);
    if (conversation.messages.length > MAX_HISTORY) {
      conversation.messages.splice(0, conversation.messages.length - MAX_HISTORY);
    }
    // The author has, by definition, read their own message.
    state.reads.set(readKey(authorId, conversation.id), message.seq);
    save();
    return message;
  }

  function postChannelMessage({ channelId, authorId, text }) {
    const channel = mustChannel(channelId);
    const body = cleanText(text);
    if (!channel.members.has(authorId)) throw httpError(403, `Join #${channel.name} before posting.`);
    const conversation = state.conversations.get(channelId);
    return appendMessage(conversation, {
      authorId,
      text: body,
      mentions: parseMentions(body, (name) => getUserByName(name)),
    });
  }

  function postDirectMessage({ fromId, toId, text }) {
    mustUser(fromId);
    mustUser(toId);
    const body = cleanText(text);
    const conversation = ensureDmConversation(fromId, toId);
    // Everyone in a DM is implicitly "mentioned" — that is what a DM is.
    return appendMessage(conversation, { authorId: fromId, text: body, mentions: [toId] });
  }

  function history(conversationId, { before = null, limit = 60 } = {}) {
    const conversation = state.conversations.get(conversationId);
    if (!conversation) return [];
    let messages = conversation.messages;
    if (before) {
      const index = messages.findIndex((m) => m.id === before);
      if (index > -1) messages = messages.slice(0, index);
    }
    return messages.slice(-Math.max(1, Math.min(200, limit))).map(publicMessage);
  }

  // -------------------------------------------------------------------- unread

  const readKey = (userId, conversationId) => `${userId}|${conversationId}`;

  /** Count messages newer than the user's read cursor, and how many mention them. */
  function unreadFor(userId, conversationId) {
    const conversation = state.conversations.get(conversationId);
    if (!conversation) return { unread: 0, mentions: 0, lastReadSeq: 0 };
    const cursor = state.reads.get(readKey(userId, conversationId)) ?? 0;

    let unread = 0;
    let mentions = 0;
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
      const message = conversation.messages[i];
      if (message.seq <= cursor) break;
      if (message.authorId === userId) continue;
      unread++;
      if (message.mentions.includes(userId)) mentions++;
    }
    return { unread, mentions, lastReadSeq: cursor };
  }

  /** Move the read cursor forward (never backwards). */
  function markRead(userId, conversationId, upToSeq = null) {
    const conversation = state.conversations.get(conversationId);
    if (!conversation) return 0;
    const target = upToSeq ?? conversation.messages.at(-1)?.seq ?? state.reads.get(readKey(userId, conversationId)) ?? 0;
    const current = state.reads.get(readKey(userId, conversationId)) ?? 0;
    const next = Math.max(current, target);
    state.reads.set(readKey(userId, conversationId), next);
    save();
    return next;
  }

  // ------------------------------------------------------------- prefs & inbox

  function setChannelMute(userId, channelId, muted) {
    const user = mustUser(userId);
    mustChannel(channelId);
    if (muted) user.prefs.mutedChannels.add(channelId);
    else user.prefs.mutedChannels.delete(channelId);
    save();
    return user.prefs;
  }

  function setQuietHours(userId, patch) {
    const user = mustUser(userId);
    user.prefs.quietHours = sanitizeQuietHours(patch, user.prefs.quietHours);
    save();
    return user.prefs.quietHours;
  }

  function addNotification(userId, notification) {
    const list = state.notifications.get(userId) ?? [];
    list.push(notification);
    if (list.length > 100) list.splice(0, list.length - 100);
    state.notifications.set(userId, list);
    save();
    return notification;
  }

  const listNotifications = (userId) => [...(state.notifications.get(userId) ?? [])].reverse();

  function markNotificationsRead(userId, ids = null) {
    const list = state.notifications.get(userId) ?? [];
    for (const n of list) {
      if (!ids || ids.includes(n.id)) n.read = true;
    }
    save();
    return list.filter((n) => !n.read).length;
  }

  // ----------------------------------------------------------------- presence

  function setOnline(userId, delta) {
    const next = Math.max(0, (state.online.get(userId) ?? 0) + delta);
    if (next === 0) state.online.delete(userId);
    else state.online.set(userId, next);
    return next > 0;
  }
  const isOnline = (userId) => state.online.has(userId);

  // ----------------------------------------------------------------- helpers

  function mustUser(userId) {
    const user = state.users.get(userId);
    if (!user) throw httpError(404, 'Unknown user.');
    return user;
  }
  function mustChannel(channelId) {
    const channel = state.channels.get(channelId);
    if (!channel) throw httpError(404, 'Unknown channel.');
    return channel;
  }
  function cleanText(text) {
    const body = String(text ?? '').replace(/\s+$/, '');
    if (!body.trim()) throw httpError(400, 'Message is empty.');
    if (body.length > 4000) throw httpError(400, 'Message is longer than 4000 characters.');
    return body;
  }

  // ------------------------------------------------------------------ startup

  const loaded = load();
  if (!loaded && seedDemo) {
    createChannel({ name: 'general', topic: 'Everything and anything', isDefault: true });
    createChannel({ name: 'random', topic: 'Non-work chatter', isDefault: true });
    createChannel({ name: 'engineering', topic: 'Builds, bugs, deploys' });
  }

  return {
    state,
    nextSeq: () => state.seq,
    createUser, getUser, getUserByName, listUsers,
    authenticate, unclaimedAccounts,
    createSession, userForToken, destroySession,
    createChannel, getChannel, listChannels, joinChannel, leaveChannel,
    dmConversationId, ensureDmConversation, listDmThreads,
    postChannelMessage, postDirectMessage, history,
    unreadFor, markRead,
    setChannelMute, setQuietHours,
    addNotification, listNotifications, markNotificationsRead,
    setOnline, isOnline,
    newId: id,
    save,
  };
}

export function publicMessage(message) {
  return {
    id: message.id,
    seq: message.seq,
    conversationId: message.conversationId,
    scope: message.scope,
    authorId: message.authorId,
    authorName: message.authorName,
    text: message.text,
    mentions: message.mentions,
    ts: message.ts,
  };
}

export function publicUser(user, { online = false } = {}) {
  return { id: user.id, name: user.name, online };
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}
