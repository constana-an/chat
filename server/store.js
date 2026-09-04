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
  DEFAULT_DIGEST,
  DEFAULT_QUIET_HOURS,
  USERNAME_RE,
  parseMentions,
  sanitizeDigest,
  sanitizeQuietHours,
} from './notifications.js';
import { initialPosition, repetitionKey, toFen } from './chess.js';
import { describeRoll, looksLikeRoll, parseRollCommand, rollDice } from './games.js';

const scrypt = promisify(crypto.scrypt);

/** Far enough to be useful, near enough that a typo cannot schedule for 2085. */
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60_000;

/** A week, so a "snooze" cannot quietly become a permanent mute. */
const MAX_SNOOZE_MINUTES = 7 * 24 * 60;

/** Read any stored mute shape into channelId -> expiry (null = indefinite). */
function readMutes(stored) {
  if (Array.isArray(stored)) return new Map(stored.map((id) => [id, null]));   // pre-snooze data
  if (stored && typeof stored === 'object') return new Map(Object.entries(stored));
  return new Map();
}

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
    games: new Map(),        // gameId -> game
    scheduled: new Map(),    // id -> a message written now, to be sent later
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
            mutedChannels: readMutes(u.prefs?.mutedChannels),
            quietHours: { ...DEFAULT_QUIET_HOURS, ...(u.prefs?.quietHours ?? {}) },
            digest: { ...DEFAULT_DIGEST, ...(u.prefs?.digest ?? {}) },
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
      for (const game of raw.games ?? []) state.games.set(game.id, game);
      // Restored so a restart does not swallow messages scheduled before it.
      for (const item of raw.scheduled ?? []) state.scheduled.set(item.id, item);
      return true;
    } catch (err) {
      console.warn(`[store] could not read ${dataFile}: ${err.message} — starting fresh`);
      return false;
    }
  }

  function snapshot() {
    // Expired mutes are dead weight; drop them on the way out.
    const now = Date.now();
    for (const user of state.users.values()) {
      for (const [channelId, until] of user.prefs.mutedChannels) {
        if (until != null && until <= now) user.prefs.mutedChannels.delete(channelId);
      }
    }
    return {
      seq: state.seq,
      users: [...state.users.values()].map((u) => ({
        ...u,
        channels: [...u.channels],
        prefs: {
          mutedChannels: Object.fromEntries(u.prefs.mutedChannels),
          quietHours: u.prefs.quietHours,
          digest: u.prefs.digest,
        },
      })),
      channels: [...state.channels.values()].map((c) => ({ ...c, members: [...c.members] })),
      conversations: [...state.conversations.values()],
      reads: Object.fromEntries(state.reads),
      notifications: Object.fromEntries(state.notifications),
      games: [...state.games.values()],
      scheduled: [...state.scheduled.values()],
    };
  }

  function writeNow() {
    if (!dataFile) return;
    try {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(dataFile, JSON.stringify(snapshot(), null, 2), { mode: 0o600 });
      // writeFileSync only applies `mode` when creating, so re-assert it.
      fs.chmodSync(dataFile, 0o600);
    } catch (err) {
      console.warn(`[store] could not write ${dataFile}: ${err.message}`);
    }
  }

  /** Chatter can wait a quarter-second; see flush() for what cannot. */
  function save() {
    if (!dataFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeNow, 250);
    saveTimer.unref?.();
  }

  /**
   * Write immediately.
   *
   * The debounce is fine for messages — losing the last quarter-second of chat
   * to a crash is a shrug. It is not fine for a promise to do something later:
   * nothing else records that intent, so a scheduled message lost before the
   * timer fires is lost silently and forever.
   */
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    writeNow();
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
      prefs: { mutedChannels: new Map(), quietHours: { ...DEFAULT_QUIET_HOURS }, digest: { ...DEFAULT_DIGEST } },
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

  function appendMessage(conversation, { authorId, text, mentions, kind = 'text', roll = null }) {
    const message = {
      id: id('m'),
      seq: ++state.seq,
      conversationId: conversation.id,
      scope: conversation.kind,
      authorId,
      authorName: getUser(authorId)?.name ?? 'unknown',
      text,
      kind,
      roll,
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

  /**
   * A `/roll` becomes a dice message rather than text. Doing it here, beside
   * mention parsing, means rolls ride the whole existing pipeline for free:
   * history, unread counts, the event stream and persistence.
   */
  function buildMessage(text) {
    const body = cleanText(text);
    if (!looksLikeRoll(body)) {
      return { text: body, kind: 'text', roll: null, mentioned: parseMentions(body, (n) => getUserByName(n)) };
    }
    let spec;
    try {
      spec = parseRollCommand(body);
    } catch (err) {
      throw httpError(400, err.message);
    }
    if (!spec) throw httpError(400, 'Try /roll, /roll d20 or /roll 3d6.');
    const roll = rollDice(spec.dice, spec.sides);
    // A roll names nobody, so it never becomes a mention.
    return { text: describeRoll(roll), kind: 'roll', roll, mentioned: [] };
  }

  function postChannelMessage({ channelId, authorId, text }) {
    const channel = mustChannel(channelId);
    if (!channel.members.has(authorId)) throw httpError(403, `Join #${channel.name} before posting.`);
    const built = buildMessage(text);
    return appendMessage(state.conversations.get(channelId), {
      authorId,
      text: built.text,
      kind: built.kind,
      roll: built.roll,
      mentions: built.mentioned,
    });
  }

  function postDirectMessage({ fromId, toId, text }) {
    mustUser(fromId);
    mustUser(toId);
    const built = buildMessage(text);
    return appendMessage(ensureDmConversation(fromId, toId), {
      authorId: fromId,
      text: built.text,
      kind: built.kind,
      roll: built.roll,
      // Everyone in a DM is implicitly "mentioned" — that is what a DM is.
      mentions: [toId],
    });
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

  /**
   * @param {number|null} [minutes] how long to stay muted. Omitted means
   *   indefinitely — the mute only ends when someone unmutes it.
   */
  function setChannelMute(userId, channelId, muted, minutes = null) {
    const user = mustUser(userId);
    mustChannel(channelId);
    if (!muted) {
      user.prefs.mutedChannels.delete(channelId);
    } else if (minutes == null) {
      user.prefs.mutedChannels.set(channelId, null);
    } else {
      const span = Number(minutes);
      if (!Number.isFinite(span) || span <= 0 || span > MAX_SNOOZE_MINUTES) {
        throw httpError(400, `Snooze between 1 and ${MAX_SNOOZE_MINUTES} minutes.`);
      }
      user.prefs.mutedChannels.set(channelId, Date.now() + span * 60_000);
    }
    save();
    return user.prefs;
  }

  function setDigest(userId, patch) {
    const user = mustUser(userId);
    user.prefs.digest = sanitizeDigest(patch, user.prefs.digest);
    save();
    return user.prefs.digest;
  }

  const pendingDigest = (userId) => (state.notifications.get(userId) ?? []).filter((n) => n.pending);

  /** When each user's held items become old enough to be worth sending. */
  function digestDueTimes() {
    const times = [];
    for (const user of state.users.values()) {
      if (!user.prefs.digest?.enabled) continue;
      const held = pendingDigest(user.id);
      if (!held.length) continue;
      // Measured from the oldest held item, so nothing waits two intervals.
      times.push(held[0].ts + user.prefs.digest.everyMinutes * 60_000);
    }
    return times;
  }

  const usersDueForDigest = (now) =>
    [...state.users.values()]
      .filter((user) => {
        if (!user.prefs.digest?.enabled) return false;
        const held = pendingDigest(user.id);
        return held.length > 0 && held[0].ts + user.prefs.digest.everyMinutes * 60_000 <= now;
      })
      .map((user) => user.id);

  /**
   * Replace every held entry with one summary. Returns null when there was
   * nothing held, so callers can skip an empty digest.
   */
  function flushDigest(userId, now = Date.now(), { alert = true, silencedByQuietHours = false } = {}) {
    const list = state.notifications.get(userId) ?? [];
    const held = list.filter((n) => n.pending);
    if (!held.length) return null;

    state.notifications.set(userId, list.filter((n) => !n.pending));
    const digest = addNotification(userId, {
      id: id('n'),
      kind: 'digest',
      conversationId: null,
      messageId: null,
      scope: 'digest',
      from: { id: null, name: 'digest' },
      channel: null,
      preview: `${held.length} ${held.length === 1 ? 'mention' : 'mentions'} while you were away`,
      items: held.map((n) => ({
        conversationId: n.conversationId,
        from: n.from,
        channel: n.channel,
        preview: n.preview,
        ts: n.ts,
      })),
      ts: now,
      read: false,
      alert,
      bypassedMute: held.some((n) => n.bypassedMute),
      silencedByQuietHours,
      reason: silencedByQuietHours
        ? 'Your digest — silenced by quiet hours'
        : 'Your digest — everything held since the last one',
    });
    return digest;
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

  /** Held-for-digest entries are deliberately invisible until the digest fires. */
  const listNotifications = (userId) =>
    [...(state.notifications.get(userId) ?? [])].filter((n) => !n.pending).reverse();

  /**
   * "Your move" should not stack. Drop any unread notice still pointing at this
   * game before adding the new one, so a 40-move game leaves one entry, not 40.
   */
  function replaceGameNotification(userId, gameId, notification) {
    const list = state.notifications.get(userId) ?? [];
    const kept = list.filter((entry) => !(entry.gameId === gameId && !entry.read));
    state.notifications.set(userId, kept);
    return addNotification(userId, notification);
  }

  function markNotificationsRead(userId, ids = null) {
    const list = state.notifications.get(userId) ?? [];
    for (const n of list) {
      if (!ids || ids.includes(n.id)) n.read = true;
    }
    save();
    return list.filter((n) => !n.read).length;
  }

  // -------------------------------------------------------------------- games

  /**
   * A game belongs to the direct-message thread between its two players, so
   * there is exactly one place it can be found and exactly two people who can
   * touch it.
   */
  function createGame({ conversationId, whiteId, blackId, createdBy }) {
    const start = initialPosition();
    const game = {
      id: id('g'),
      kind: 'chess',
      conversationId,
      white: whiteId,
      black: blackId,
      createdBy,
      fen: toFen(start),
      // Every position that has occurred, so threefold repetition can be seen.
      history: [repetitionKey(start)],
      moves: [],
      lastMove: null,
      status: 'pending',
      result: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.games.set(game.id, game);
    save();
    return game;
  }

  /**
   * Rock-paper-scissors, best of three by default. `throws` holds the current
   * round only, and the route layer must redact an opponent's pending throw --
   * a visible choice is not a game.
   */
  function createRpsGame({ conversationId, players, createdBy, target = 2 }) {
    const game = {
      id: id('g'),
      kind: 'rps',
      conversationId,
      players: [...players],
      createdBy,
      target,
      scores: Object.fromEntries(players.map((playerId) => [playerId, 0])),
      throws: {},
      rounds: [],
      status: 'active',
      result: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.games.set(game.id, game);
    save();
    return game;
  }

  const getGame = (gameId) => state.games.get(gameId);

  /** Newest first; a thread usually has one live game and a pile of old ones. */
  const listGamesIn = (conversationId) =>
    [...state.games.values()]
      .filter((game) => game.conversationId === conversationId)
      .sort((a, b) => b.updatedAt - a.updatedAt);

  const activeGameIn = (conversationId, kind = 'chess') =>
    listGamesIn(conversationId).find((game) => (game.kind ?? 'chess') === kind && game.status !== 'finished')
    ?? null;

  function saveGame(game) {
    game.updatedAt = Date.now();
    state.games.set(game.id, game);
    save();
    return game;
  }

  // -------------------------------------------------------- scheduled sends

  /**
   * A scheduled message is *not* a message. Nothing is appended, so it has no
   * seq, takes part in no history, and counts towards nobody's unread until
   * the moment it is actually sent.
   */
  function scheduleMessage({ authorId, kind, channelId = null, toId = null, text, deliverAt }) {
    mustUser(authorId);
    const when = Number(deliverAt);
    if (!Number.isFinite(when)) throw httpError(400, 'deliverAt must be a timestamp in milliseconds.');
    if (when <= Date.now()) throw httpError(400, 'Pick a time in the future.');
    if (when > Date.now() + MAX_SCHEDULE_AHEAD_MS) throw httpError(400, 'Schedule at most a year ahead.');

    // Fail loudly now rather than silently at delivery.
    const body = cleanText(text);
    if (kind === 'channel') {
      const channel = mustChannel(channelId);
      if (!channel.members.has(authorId)) throw httpError(403, `Join #${channel.name} before posting.`);
    } else {
      mustUser(toId);
    }

    const item = {
      id: id('s'),
      authorId, kind, channelId, toId,
      text: body,
      deliverAt: when,
      createdAt: Date.now(),
      status: 'pending',
      error: null,
    };
    state.scheduled.set(item.id, item);
    flush();
    return item;
  }

  const pendingScheduled = () =>
    [...state.scheduled.values()].filter((item) => item.status === 'pending');

  /** The soonest moment anything needs doing, or null when nothing does. */
  function nextDueAt() {
    const times = [...pendingScheduled().map((item) => item.deliverAt), ...digestDueTimes()];
    return times.length ? Math.min(...times) : null;
  }

  const dueScheduled = (now) =>
    pendingScheduled().filter((item) => item.deliverAt <= now).sort((a, b) => a.deliverAt - b.deliverAt);

  /** Sent messages are their own record; only failures are worth keeping. */
  function completeScheduled(itemId) {
    state.scheduled.delete(itemId);
    flush();
  }

  function failScheduled(itemId, reason) {
    const item = state.scheduled.get(itemId);
    if (!item) return;
    item.status = 'failed';
    item.error = String(reason).slice(0, 200);
    flush();
  }

  const listScheduled = (authorId) =>
    [...state.scheduled.values()]
      .filter((item) => item.authorId === authorId)
      .sort((a, b) => a.deliverAt - b.deliverAt);

  function cancelScheduled(itemId, authorId) {
    const item = state.scheduled.get(itemId);
    if (!item) throw httpError(404, 'No such scheduled message.');
    if (item.authorId !== authorId) throw httpError(403, 'That is not yours to cancel.');
    state.scheduled.delete(itemId);
    flush();
    return item;
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
    setChannelMute, setQuietHours, setDigest,
    pendingDigest, usersDueForDigest, flushDigest,
    addNotification, listNotifications, markNotificationsRead, replaceGameNotification,
    createGame, createRpsGame, getGame, listGamesIn, activeGameIn, saveGame,
    scheduleMessage, listScheduled, cancelScheduled,
    nextDueAt, dueScheduled, completeScheduled, failScheduled,
    setOnline, isOnline,
    newId: id,
    save,
    flush,
  };
}

export function publicMessage(message) {
  return {
    id: message.id,
    seq: message.seq,
    conversationId: message.conversationId,
    scope: message.scope,
    kind: message.kind ?? 'text',
    roll: message.roll ?? null,
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
