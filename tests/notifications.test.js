import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_QUIET_HOURS,
  formatClock,
  isQuietHoursActive,
  parseClock,
  parseMentions,
  isChannelMuted,
  mutedUntil,
  sanitizeDigest,
  routeMessage,
  sanitizeQuietHours,
} from '../server/notifications.js';

const USERS = { ada: { id: 'u_ada', name: 'ada' }, grace: { id: 'u_grace', name: 'grace' } };
const resolve = (name) => USERS[name];

const recipient = ({ muted = [], quietHours = {} } = {}) => ({
  id: 'u_ada',
  prefs: {
    mutedChannels: new Set(muted),
    quietHours: { ...DEFAULT_QUIET_HOURS, ...quietHours },
  },
});

const at = (hhmm) => new Date(`2026-08-26T${hhmm}:00.000Z`);

test('parseMentions finds known usernames only', () => {
  assert.deepEqual(parseMentions('hey @ada and @grace', resolve), ['u_ada', 'u_grace']);
  assert.deepEqual(parseMentions('@nobody here', resolve), []);
  assert.deepEqual(parseMentions('@ada @ada @ada', resolve), ['u_ada'], 'deduplicates');
  assert.deepEqual(parseMentions('ping @ADA', resolve), ['u_ada'], 'case-insensitive');
});

test('parseMentions ignores emails, paths and trailing punctuation', () => {
  assert.deepEqual(parseMentions('mail me at ada@grace.dev', resolve), [], 'email local@domain is not a mention');
  assert.deepEqual(parseMentions('see docs/@ada', resolve), [], 'path segment is not a mention');
  assert.deepEqual(parseMentions('thanks @ada.', resolve), ['u_ada'], 'trailing period is punctuation');
  assert.deepEqual(parseMentions('(@grace)', resolve), ['u_grace']);
});

test('clock parsing round-trips and rejects nonsense', () => {
  assert.equal(parseClock('22:30'), 1350);
  assert.equal(parseClock('7:05'), 425);
  assert.equal(formatClock(425), '07:05');
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('12:60'), null);
  assert.equal(parseClock('nope'), null);
});

test('quiet hours handle same-day and wrapping windows', () => {
  const day = { enabled: true, start: '09:00', end: '17:00', tzOffsetMinutes: 0 };
  assert.equal(isQuietHoursActive(day, at('12:00')), true);
  assert.equal(isQuietHoursActive(day, at('08:59')), false);
  assert.equal(isQuietHoursActive(day, at('17:00')), false, 'end is exclusive');

  const night = { enabled: true, start: '22:00', end: '08:00', tzOffsetMinutes: 0 };
  assert.equal(isQuietHoursActive(night, at('23:30')), true);
  assert.equal(isQuietHoursActive(night, at('03:00')), true);
  assert.equal(isQuietHoursActive(night, at('09:00')), false);

  assert.equal(isQuietHoursActive({ ...night, enabled: false }, at('23:30')), false);
  assert.equal(isQuietHoursActive({ enabled: true, start: '10:00', end: '10:00' }, at('10:00')), false);
});

test('quiet hours are evaluated in the user local timezone', () => {
  // 23:00 in UTC+9 is 14:00 UTC.
  const tokyo = { enabled: true, start: '22:00', end: '08:00', tzOffsetMinutes: 540 };
  assert.equal(isQuietHoursActive(tokyo, at('14:00')), true);
  assert.equal(isQuietHoursActive({ ...tokyo, tzOffsetMinutes: 0 }, at('14:00')), false);
});

test('ordinary channel activity counts as unread but never alerts', () => {
  const decision = routeMessage({ scope: 'channel', recipient: recipient(), channelId: 'ch_1', mentions: [] });
  assert.equal(decision.kind, 'activity');
  assert.equal(decision.countsAsUnread, true);
  assert.equal(decision.inbox, false);
  assert.equal(decision.alert, false);
});

test('a muted channel still accumulates unread', () => {
  const decision = routeMessage({
    scope: 'channel', recipient: recipient({ muted: ['ch_1'] }), channelId: 'ch_1', mentions: [],
  });
  assert.equal(decision.channelMuted, true);
  assert.equal(decision.countsAsUnread, true, 'muting silences alerts, it does not hide activity');
  assert.equal(decision.alert, false);
});

test('@mentions bypass a channel mute', () => {
  const decision = routeMessage({
    scope: 'channel', recipient: recipient({ muted: ['ch_1'] }), channelId: 'ch_1', mentions: ['u_ada'],
  });
  assert.equal(decision.kind, 'mention');
  assert.equal(decision.inbox, true);
  assert.equal(decision.alert, true);
  assert.equal(decision.bypassedMute, true);
  assert.match(decision.reason, /despite the channel mute/);
});

test('direct messages bypass every channel mute', () => {
  const decision = routeMessage({
    scope: 'direct',
    // Even with every channel muted, a DM is not in a channel at all.
    recipient: recipient({ muted: ['ch_1', 'ch_2'] }),
    mentions: ['u_ada'],
  });
  assert.equal(decision.kind, 'direct');
  assert.equal(decision.alert, true);
  assert.equal(decision.channelMuted, false);
});

test('quiet hours silence alerts but keep the inbox entry', () => {
  const quiet = { enabled: true, start: '22:00', end: '08:00', tzOffsetMinutes: 0 };

  const mention = routeMessage({
    scope: 'channel', recipient: recipient({ quietHours: quiet }),
    channelId: 'ch_1', mentions: ['u_ada'], now: at('23:00'),
  });
  assert.equal(mention.inbox, true, 'still recorded');
  assert.equal(mention.alert, false, 'but no toast');
  assert.equal(mention.silencedByQuietHours, true);

  const outside = routeMessage({
    scope: 'channel', recipient: recipient({ quietHours: quiet }),
    channelId: 'ch_1', mentions: ['u_ada'], now: at('12:00'),
  });
  assert.equal(outside.alert, true);
});

test('allowDirect lets DMs ring through quiet hours, mentions still silenced', () => {
  const quietHours = { enabled: true, start: '22:00', end: '08:00', tzOffsetMinutes: 0, allowDirect: true };
  const now = at('23:00');

  const dm = routeMessage({ scope: 'direct', recipient: recipient({ quietHours }), mentions: ['u_ada'], now });
  assert.equal(dm.alert, true);
  assert.match(dm.reason, /allowed through quiet hours/);

  const mention = routeMessage({
    scope: 'channel', recipient: recipient({ quietHours }), channelId: 'ch_1', mentions: ['u_ada'], now,
  });
  assert.equal(mention.alert, false);
  assert.equal(mention.inbox, true);
});

test('mute and quiet hours compose: mention in a muted channel during quiet hours', () => {
  const decision = routeMessage({
    scope: 'channel',
    recipient: recipient({
      muted: ['ch_1'],
      quietHours: { enabled: true, start: '22:00', end: '08:00', tzOffsetMinutes: 0 },
    }),
    channelId: 'ch_1',
    mentions: ['u_ada'],
    now: at('23:00'),
  });
  assert.equal(decision.inbox, true, 'the mute never drops it');
  assert.equal(decision.bypassedMute, true);
  assert.equal(decision.alert, false, 'quiet hours still downgrade it to silent');
});

test('sanitizeQuietHours rejects junk and keeps current values', () => {
  const current = { ...DEFAULT_QUIET_HOURS, start: '21:00' };
  assert.equal(sanitizeQuietHours({ start: 'banana' }, current).start, '21:00');
  assert.equal(sanitizeQuietHours({ start: '7:5' }, current).start, '21:00');
  assert.equal(sanitizeQuietHours({ start: '7:05' }, current).start, '07:05');
  assert.equal(sanitizeQuietHours({ enabled: 'yes' }, current).enabled, true);
  assert.equal(sanitizeQuietHours({ tzOffsetMinutes: 99999 }, current).tzOffsetMinutes, 0);
  assert.equal(sanitizeQuietHours(null, current).start, '21:00');
});

// ───────────────────────────────── snooze (change 1) ─────────────────────

const snoozed = (until) => ({ id: 'u_ada', prefs: { mutedChannels: new Map([['ch_1', until]]) } });

test('a snooze ends by being in the past — nothing has to lift it', () => {
  const noon = Date.UTC(2026, 7, 30, 12, 0, 0);
  const user = snoozed(noon + 60 * 60_000);   // muted for an hour

  assert.equal(isChannelMuted(user, 'ch_1', noon), true, 'muted at the start');
  assert.equal(isChannelMuted(user, 'ch_1', noon + 59 * 60_000), true, 'still muted at 59 minutes');
  assert.equal(isChannelMuted(user, 'ch_1', noon + 60 * 60_000), false, 'exactly on the hour it is over');
  assert.equal(isChannelMuted(user, 'ch_1', noon + 61 * 60_000), false, 'and after');

  // No timer ran, no state changed -- the same record answers differently
  // only because the clock moved.
  assert.equal(mutedUntil(user, 'ch_1'), noon + 60 * 60_000, 'the record is untouched');
});

test('an indefinite mute never lapses, and an unmuted channel is never muted', () => {
  const forever = snoozed(null);
  assert.equal(isChannelMuted(forever, 'ch_1', 0), true);
  assert.equal(isChannelMuted(forever, 'ch_1', 8.64e15), true, 'still muted in the far future');

  assert.equal(isChannelMuted(forever, 'ch_other'), false);
  assert.equal(mutedUntil(forever, 'ch_other'), undefined, 'undefined means "not muted at all"');
  assert.equal(mutedUntil(forever, 'ch_1'), null, 'null means "muted, with no end"');
});

test('mutes stored before snooze existed still read as indefinite', () => {
  for (const stored of [new Set(['ch_1']), ['ch_1'], { ch_1: null }]) {
    const user = { id: 'u_ada', prefs: { mutedChannels: stored } };
    assert.equal(isChannelMuted(user, 'ch_1', Date.now()), true, String(stored));
    assert.equal(isChannelMuted(user, 'ch_2', Date.now()), false);
  }
});

test('a snooze changes nothing about what a mute means', () => {
  const noon = Date.UTC(2026, 7, 30, 12, 0, 0);
  const user = { ...snoozed(noon + 60 * 60_000), prefs: { mutedChannels: new Map([['ch_1', noon + 3600_000]]) } };
  const at = (t) => new Date(t);

  // Still counted, still silent -- the snooze only decides *whether* muted.
  const activity = routeMessage({ scope: 'channel', recipient: user, channelId: 'ch_1', mentions: [], now: at(noon) });
  assert.equal(activity.channelMuted, true);
  assert.equal(activity.countsAsUnread, true, 'a snoozed channel still counts unread');
  assert.equal(activity.alert, false);

  // And a mention still gets through, exactly as with an indefinite mute.
  const mention = routeMessage({ scope: 'channel', recipient: user, channelId: 'ch_1', mentions: ['u_ada'], now: at(noon) });
  assert.equal(mention.bypassedMute, true);
  assert.equal(mention.alert, true);

  // An hour later the channel is simply not muted any more.
  const later = routeMessage({ scope: 'channel', recipient: user, channelId: 'ch_1', mentions: [], now: at(noon + 3700_000) });
  assert.equal(later.channelMuted, false);
});

// ───────────────────────────────── digest (change 3) ─────────────────────

const withDigest = (extra = {}) => ({
  id: 'u_ada',
  prefs: { mutedChannels: new Map(), quietHours: { ...DEFAULT_QUIET_HOURS }, digest: { enabled: true, everyMinutes: 60 }, ...extra },
});

test('a digest holds mentions but never a direct message', () => {
  const user = withDigest();

  const mention = routeMessage({ scope: 'channel', recipient: user, channelId: 'ch_1', mentions: ['u_ada'] });
  assert.equal(mention.inbox, true, 'it is still going to reach them');
  assert.equal(mention.delivery, 'digest');
  assert.equal(mention.batched, true);
  assert.equal(mention.alert, false, 'but it does not interrupt on its own');
  assert.match(mention.reason, /held for your digest/);

  const dm = routeMessage({ scope: 'direct', recipient: user, mentions: ['u_ada'] });
  assert.equal(dm.delivery, 'immediate', 'a direct message is never batched');
  assert.equal(dm.alert, true);
});

test('with the digest off nothing changes at all', () => {
  const user = { id: 'u_ada', prefs: { mutedChannels: new Map(), quietHours: { ...DEFAULT_QUIET_HOURS } } };
  const mention = routeMessage({ scope: 'channel', recipient: user, channelId: 'ch_1', mentions: ['u_ada'] });
  assert.equal(mention.delivery, 'immediate');
  assert.equal(mention.batched, false);
  assert.equal(mention.alert, true);
});

test('a held mention still counts unread, and still ignores a mute', () => {
  const user = withDigest({ mutedChannels: new Map([['ch_1', null]]) });
  const held = routeMessage({ scope: 'channel', recipient: user, channelId: 'ch_1', mentions: ['u_ada'] });

  assert.equal(held.countsAsUnread, true, 'batching is about noise, not about hiding');
  assert.equal(held.bypassedMute, true, 'the mute is still powerless');
  assert.equal(held.delivery, 'digest');
});

test('ordinary channel activity is not something a digest can collect', () => {
  const activity = routeMessage({ scope: 'channel', recipient: withDigest(), channelId: 'ch_1', mentions: [] });
  assert.equal(activity.inbox, false);
  assert.equal(activity.delivery, 'none', 'it was never going to the inbox, digest or not');
});

test('sanitizeDigest refuses intervals that make a digest pointless', () => {
  assert.equal(sanitizeDigest({ enabled: true }).enabled, true);
  assert.equal(sanitizeDigest({ everyMinutes: 30 }).everyMinutes, 30);
  assert.equal(sanitizeDigest({ everyMinutes: 1 }).everyMinutes, 60, 'a one-minute digest is just a slow alert');
  assert.equal(sanitizeDigest({ everyMinutes: 5000 }).everyMinutes, 60);
  assert.equal(sanitizeDigest({ everyMinutes: 'hourly' }).everyMinutes, 60);
  assert.equal(sanitizeDigest(null).enabled, false);
});
