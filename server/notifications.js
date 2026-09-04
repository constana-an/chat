/**
 * Notification routing rules.
 *
 * These functions are pure: they take a message plus the recipient's
 * preferences and decide what the recipient should be told about it.
 * Nothing here touches the store, so the policy is easy to test.
 *
 * Policy, in one paragraph:
 *   Unread counts are always tracked, even for muted channels -- muting
 *   silences alerts, it does not hide activity. Alerts (bell + toast) are
 *   raised only for direct messages and @mentions. A channel mute suppresses
 *   ordinary channel activity but never suppresses a DM or an @mention:
 *   those always land in the inbox. Quiet hours are a separate, later stage:
 *   they can downgrade an alert to a silent inbox entry, but they never drop
 *   it, and `allowDirect` lets DMs ring through anyway.
 */

/** Usernames are lowercase, 2-32 chars of [a-z0-9._-]. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

const MENTION_RE = /(?:^|[^\w@/])@([a-z0-9][a-z0-9._-]{1,31})/gi;

/**
 * Extract @mentions from message text.
 * @param {string} text
 * @param {(name: string) => {id: string, name: string} | undefined} resolve
 * @returns {string[]} unique user ids, in order of first appearance
 */
export function parseMentions(text, resolve) {
  const ids = [];
  for (const match of String(text).matchAll(MENTION_RE)) {
    // Trailing punctuation is not part of a username: "@ada." mentions "ada".
    const raw = match[1].replace(/[.\-_]+$/, '');
    const user = resolve(raw.toLowerCase());
    if (user && !ids.includes(user.id)) ids.push(user.id);
  }
  return ids;
}

/** "22:30" -> 1350. Returns null for anything malformed. */
export function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 1350 -> "22:30" */
export function formatClock(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Off by default: batching mentions is a choice, not the house style. */
export const DEFAULT_DIGEST = Object.freeze({ enabled: false, everyMinutes: 60 });

export const DEFAULT_QUIET_HOURS = Object.freeze({
  enabled: false,
  start: '22:00',
  end: '08:00',
  // Minutes to ADD to UTC to get the user's local time (i.e. -Date#getTimezoneOffset()).
  tzOffsetMinutes: 0,
  // When true, direct messages still ring during quiet hours.
  allowDirect: false,
});

/**
 * Is `now` inside the user's quiet-hours window?
 * Windows may wrap past midnight (22:00 -> 08:00).
 */
export function isQuietHoursActive(quietHours, now = new Date()) {
  const qh = { ...DEFAULT_QUIET_HOURS, ...(quietHours ?? {}) };
  if (!qh.enabled) return false;

  const start = parseClock(qh.start);
  const end = parseClock(qh.end);
  if (start === null || end === null) return false;
  if (start === end) return false; // zero-length window is "always off"

  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const local = (((utcMinutes + (qh.tzOffsetMinutes | 0)) % 1440) + 1440) % 1440;

  return start < end ? local >= start && local < end : local >= start || local < end;
}

/**
 * Decide what one recipient gets from one message.
 *
 * @param {object} args
 * @param {'channel'|'direct'} args.scope
 * @param {object} args.recipient       - {id, prefs:{mutedChannels:Set|Array, quietHours}}
 * @param {string[]} args.mentions      - user ids mentioned in the message
 * @param {string} [args.channelId]
 * @param {Date} [args.now]
 * @returns {{
 *   userId: string,
 *   countsAsUnread: boolean,
 *   kind: 'direct'|'mention'|'activity',
 *   alert: boolean,          // raise a toast / sound
 *   inbox: boolean,          // record in the notification list
 *   channelMuted: boolean,
 *   bypassedMute: boolean,   // reached them even though the channel is muted
 *   quietHoursActive: boolean,
 *   silencedByQuietHours: boolean,
 *   reason: string           // short human-readable explanation
 * }}
 */
export function routeMessage({ scope, recipient, mentions = [], channelId, now = new Date() }) {
  const muted = isChannelMuted(recipient, channelId, now.getTime());
  const mentioned = mentions.includes(recipient.id);
  const kind = scope === 'direct' ? 'direct' : mentioned ? 'mention' : 'activity';

  // Stage 1 -- does this belong in the notification inbox at all?
  // DMs and mentions always do; ordinary channel chatter never does.
  const inbox = kind !== 'activity';

  // Stage 2 -- when. A direct message is never batched; that is the whole
  // point of it being direct. Everything else the user asked to batch waits
  // for the digest instead of interrupting one mention at a time.
  const digestOn = recipient.prefs?.digest?.enabled === true;
  const batched = inbox && kind !== 'direct' && digestOn;

  // Stage 3 -- how loud. Quiet hours can downgrade an alert to a silent inbox
  // entry. A batched item has no alert of its own; the digest carries one.
  const quietHoursActive = isQuietHoursActive(recipient.prefs?.quietHours, now);
  const allowDirect = recipient.prefs?.quietHours?.allowDirect === true;
  const ringsThroughQuietHours = kind === 'direct' && allowDirect;
  const silencedByQuietHours = inbox && !batched && quietHoursActive && !ringsThroughQuietHours;

  return {
    userId: recipient.id,
    // Muting never hides activity from the unread count.
    countsAsUnread: true,
    kind,
    alert: inbox && !batched && !silencedByQuietHours,
    inbox,
    /** 'none' | 'immediate' | 'digest' — when this reaches the person. */
    delivery: !inbox ? 'none' : batched ? 'digest' : 'immediate',
    batched,
    channelMuted: muted,
    bypassedMute: inbox && muted,
    quietHoursActive,
    silencedByQuietHours,
    reason: explain({ kind, muted, batched, silencedByQuietHours, quietHoursActive, ringsThroughQuietHours }),
  };
}

function explain({ kind, muted, batched, silencedByQuietHours, quietHoursActive, ringsThroughQuietHours }) {
  if (kind === 'activity') {
    return muted ? 'Channel activity in a muted channel — unread count only'
                 : 'Channel activity — unread count only';
  }
  const what = kind === 'direct' ? 'Direct message' : 'You were mentioned';
  const parts = [what];
  if (muted) parts.push('delivered despite the channel mute');
  if (batched) parts.push('held for your digest');
  if (silencedByQuietHours) parts.push('silenced by quiet hours');
  else if (quietHoursActive && ringsThroughQuietHours) parts.push('allowed through quiet hours');
  return parts.join(' — ');
}

/**
 * When does a channel's mute end?
 *
 * @returns {number|null|undefined} a timestamp for a mute that lapses on its own,
 *   `null` for an indefinite mute, `undefined` when the channel is not muted.
 *   Older stored shapes (a Set or an array of ids) mean an indefinite mute.
 */
export function mutedUntil(user, channelId) {
  const muted = user?.prefs?.mutedChannels;
  if (!muted || !channelId) return undefined;
  if (muted instanceof Map) return muted.has(channelId) ? muted.get(channelId) : undefined;
  if (muted instanceof Set) return muted.has(channelId) ? null : undefined;
  if (Array.isArray(muted)) return muted.includes(channelId) ? null : undefined;
  if (typeof muted === 'object') return channelId in muted ? muted[channelId] : undefined;
  return undefined;
}

/**
 * A timed mute ends by simply being in the past -- nothing has to wake up to
 * lift it, which is why the server needs no scheduler for snooze.
 */
export function isChannelMuted(user, channelId, now = Date.now()) {
  const until = mutedUntil(user, channelId);
  if (until === undefined) return false;
  return until === null || until > now;
}

/** Normalise a quiet-hours patch coming from the client. */
export function sanitizeQuietHours(patch, current = DEFAULT_QUIET_HOURS) {
  const next = { ...DEFAULT_QUIET_HOURS, ...current };
  if (patch == null || typeof patch !== 'object') return next;

  if ('enabled' in patch) next.enabled = Boolean(patch.enabled);
  if ('allowDirect' in patch) next.allowDirect = Boolean(patch.allowDirect);
  if ('start' in patch && parseClock(patch.start) !== null) next.start = formatClock(parseClock(patch.start));
  if ('end' in patch && parseClock(patch.end) !== null) next.end = formatClock(parseClock(patch.end));
  if ('tzOffsetMinutes' in patch && Number.isFinite(Number(patch.tzOffsetMinutes))) {
    const offset = Math.trunc(Number(patch.tzOffsetMinutes));
    if (offset >= -900 && offset <= 900) next.tzOffsetMinutes = offset;
  }
  return next;
}

/** Normalise a digest patch coming from the client. */
export function sanitizeDigest(patch, current = DEFAULT_DIGEST) {
  const next = { ...DEFAULT_DIGEST, ...current };
  if (patch == null || typeof patch !== 'object') return next;
  if ('enabled' in patch) next.enabled = Boolean(patch.enabled);
  if ('everyMinutes' in patch) {
    const every = Math.trunc(Number(patch.everyMinutes));
    // Below a few minutes a "digest" is just a slow notification.
    if (Number.isFinite(every) && every >= 5 && every <= 24 * 60) next.everyMinutes = every;
  }
  return next;
}
