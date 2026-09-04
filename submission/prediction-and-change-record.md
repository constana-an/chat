# A1 — Prediction and change record

Steps 3 and 4. The predictions below were written **before** any of the three
requirements were implemented.

> Lines marked **[check]** are drafted from tracing the code and from our discussion.
> Read each one against the code and rewrite it in your own words where you disagree —
> Step 5 asks which of *your* predictions differed most from what happened.

---

## Step 3 — Predictions

### My three going-in positions

1. **Change 2 (scheduled messages) will be the hardest.** Not because the notification
   logic is hard, but because it is the only one that needs infrastructure that does not
   exist anywhere in the project yet.
2. **The stale-UI problem in change 1 is real.** A snooze that expires on a timer is easy;
   a sidebar that already rendered `🔕` and never hears that the hour is up is the part
   that will actually cost time.
3. **The derived design's cost is not performance.** With `MAX_HISTORY = 500` per
   conversation (`store.js:21`) and a handful of users, re-deriving an inbox is cheap.
   The real cost is elsewhere — see the alternative-design notes.

---

### Change 1 — Snooze (mute a channel for an hour; it unmutes itself)

**Generated design — components I expect to change**

| Component | Why |
| --- | --- |
| `prefs.mutedChannels` (`store.js:142`) | It is a `Set<channelId>` — pure membership, no time. Must become channel → expiry. |
| serialisation (`store.js:75`, `:102`) | The set is written out as a plain array; the shape changes with it. |
| `isChannelMuted()` (`notifications.js:150`) | Must take `now` and compare. `routeMessage()` already receives `now`, so it can pass it down. |
| `setChannelMute()` (`store.js:483`) | Needs a duration, not a boolean. |
| `PATCH /api/channels/:id/prefs` (`routes.js`) | Accepts `{muted}` today; needs a duration. |
| **outside the boundary:** `channelView()` (`routes.js`) | Computes `muted` for the sidebar. That value is now time-dependent. |
| **outside the boundary:** client (`public/app.js`, `styles.css`) | The mute chip and the settings checkbox are booleans; the drawer shows a stale `🔕` after expiry. |

**[check] I do not expect `routeMessage()` itself to change at all.** It calls a predicate;
the predicate learns about time. If that turns out to be wrong, the boundary is worse than
the as-built diagram claims.

**Where it lands on the alternative** — marker ① . A snooze is a rule with an end time
(*Subscription rules*), and because *Matcher* runs at read time an expired rule simply
stops matching. **No timer, and no stale UI**, because nothing was cached to go stale.

---

### Change 2 — Scheduled messages

**Generated design — components I expect to change**

| Component | Why |
| --- | --- |
| **new:** a scheduler | There is no scheduler in the project. The only timers are the SSE keep-alive (`hub.js:21`) and the save debounce (`store.js:115`). Neither is one. |
| **new:** a pending-message store + persistence | And it must survive a restart, or messages scheduled before a crash never arrive. |
| `appendMessage()` (`store.js`) | Assigns `seq: ++state.seq` at creation, and unread counts `seq > cursor`. A message written now and delivered later would be mis-ordered **and** count as unread immediately. |
| **new:** routes to schedule / list / cancel | |
| **outside the boundary:** the composer (`public/app.js`) | Needs a "send later" affordance and a pending list. |

**[check] My prediction: defer the whole write.** Do not append at compose time — hold the
request in a queue and run the ordinary post path at delivery. If that works,
`deliver()` and `routeMessage()` are untouched, and the requirement lands almost entirely
*outside* the notification boundary. **This change is the real test of whether the boundary
in the as-built diagram was drawn in the right place.**

**Where it lands on the alternative** — marker ② . An entry in the *Message log* carries a
visible-from time and every derived query filters on it. Correctness needs no scheduler.

**[check] But I expect this prediction to be partly wrong:** something still has to wake up
at delivery time to *push* to connected clients. The scheduler does not disappear, it stops
being load-bearing for correctness and becomes an optimisation.

---

### Change 3 — Digest

**Generated design — components I expect to change**

| Component | Why |
| --- | --- |
| `routeMessage()` (`notifications.js:107`) | Returns `{inbox, alert}` today. A digest is a third outcome: in the inbox, but held. **This is the first change that modifies the decision function itself.** |
| `deliver()` (`routes.js:238`) | Must route held items to a bucket instead of `hub.send()`. |
| `addNotification()` / `replaceGameNotification()` (`store.js:496`) | The digest interacts with the existing "your move replaces itself" behaviour. |
| **new:** pending-digest state + last-digest-sent per user | |
| **reused:** the scheduler from change 2 | Which is presumably why the assignment says to do them in order. |
| **outside the boundary:** client inbox rendering | One entry that stands for many. |

**[check] I expect a collision with quiet hours.** Both are "hold this back", by different
mechanisms. What happens when a digest flush falls inside a quiet-hours window? Nothing in
the current code has a place to answer that.

**Where it lands on the alternative** — marker ③ . *Urgency router* reads the urgency the
matched rule already declares, and *Digest* re-runs the same *Inbox query* from a digest
cursor. No pending bucket and no per-notification state, because nothing was materialised.

---

## Step 4 — Change record

*Filled in as each change was made.*

### Change 1 — Snooze

**What it actually affected**

| Where | What |
| --- | --- |
| `notifications.js` | `isChannelMuted()` gained a `now`; new `mutedUntil()` reports the end time. |
| `notifications.js:108` | **One line inside `routeMessage()` after all** — threading `now.getTime()` into the predicate. |
| `store.js` | `mutedChannels` became a `Map` (id → expiry \| null); `setChannelMute()` takes minutes; a `MAX_SNOOZE_MINUTES` cap. |
| `store.js` | **Unpredicted:** a `readMutes()` shim, because data already on disk stores an array of ids. |
| `store.js` snapshot | Expired entries are pruned on save so `db.json` does not accumulate dead mutes. |
| `routes.js` | Accepts `minutes`; `channelView` exposes `mutedUntil`; `selfView` emits an object, not an array. |
| **outside the boundary:** `public/app.js` | Countdown label, a "1h" snooze button, and a client timer that re-renders on expiry. |
| **outside the boundary:** `public/styles.css` | One button style. |

**No scheduler was added.** The mute lapses because the clock passes it: the same stored
record answers `true` then `false` with nothing having run in between. Verified against a
live server with a 3-second snooze — `muted` flipped on its own, and the only timers in
`store.js` are still the save debounce.

**Rounds of instruction:** one pass, no rework. Tests passed first run.

**Where I intervened:** Before this change was written, I confirmed the prediction that a
lapsed snooze would leave the interface stale. That is why the client timer was treated as
required work rather than optional polish — and it turned out to be the largest part of the
change. Without it the server would have expired the mute silently and the sidebar would have
kept showing 🔕 for the rest of the hour.

**What was easy, what was hard**

- **Easy — the decision logic.** Almost exactly as predicted: `routeMessage()` did not
  change in substance. A snoozed channel still counts unread, and a mention still bypasses
  it, with no new code for either. Those two invariants held for free because the mute was
  never load-bearing in the first place.
- **Hard — everything outside the boundary.** The prediction was right about where the
  cost would fall. The server lifts a snooze silently, so nothing is pushed when it ends;
  the sidebar would have shown `🔕` for the rest of the hour. Fixing it needed a client
  timer that wakes at the expiry *and* ticks each minute to keep the countdown honest.
  This was the single largest piece of work in the change, and none of it is notification
  logic.
- **Where the prediction was slightly wrong:** I said `routeMessage()` would not change
  "at all". One line did — the predicate now needs the time. Small, but it means the
  decision function is not quite as insulated from the mute as the as-built diagram
  suggests.
- **Unforeseen:** already-persisted data. Any shape change to a preference has to read the
  old shape too, which the prediction did not mention.

### Change 2 — Scheduled messages

**What it actually affected**

| Where | What |
| --- | --- |
| **new** `server/scheduler.js` | One timer for the whole app, not one per item: sleep until the soonest due thing, do everything due, re-arm. The wait is capped at 30 s so a suspended laptop or a clock jump makes a message late, never lost. |
| `store.js` | A `scheduled` queue, persisted; `nextDueAt` / `dueScheduled` / `complete` / `fail`. |
| `routes.js` | `deliverAt` on the two existing message endpoints; list and cancel; `deliverScheduled()`. |
| `index.js` | Builds the scheduler and starts it **after** the store loads, so restarts recover. |
| **outside the boundary:** `public/` | A clock button, a time input, and the pending queue with cancel. |

**`deliver()` and `routeMessage()` were not touched. Zero lines.** The prediction held:
holding the whole write back, rather than writing early and hiding it, meant a scheduled
message becomes an ordinary message at delivery and takes the ordinary path. Mentions
resolve then, `seq` is allocated then, unread starts then — for free, because nothing
special happened. A scheduled `/roll` even rolls its dice at delivery, which nobody had to
implement.

**Rounds of instruction:** two. The first produced everything above and passed. The second
was forced by the restart test.

**Where I intervened:** Not in the implementation — I set the framing and let it run. My one
substantive intervention in this stretch was during the prediction phase: I rejected the claim
that the derived design's cost is processing. Checked against the code, that was right — with
a 500-message cap per conversation and a handful of users, re-deriving an inbox is microseconds,
and the argument being made was a scale argument that does not apply here. **It did not change
how this requirement was built; it changed the cost recorded on the alternative design (note 3),
from performance to retroactivity.**

The consequence of standing back is worth recording too: the durability bug above was surfaced
by the restart test, not by me or the agent reading the code. Nobody was going to notice a
250 ms debounce by inspection.

**What was easy, what was hard**

- **Easy — the notification system, entirely.** This change is the strongest evidence the
  as-built boundary is drawn in the right place: the requirement that sounds most like
  "notifications" turned out to have nothing to do with them.
- **Hard — the thing nobody was looking at.** The restart test failed, and the cause was
  not the scheduler. `save()` has always debounced writes by 250 ms. Losing a quarter
  second of chat to a crash is a shrug; **losing a scheduled message is silent and
  permanent, because nothing else records the intent.** A pre-existing weakness became
  load-bearing the moment the app gained a notion of "later". Fixed with a `flush()` that
  writes synchronously, used for scheduling and on `SIGINT`/`SIGTERM`.
- **What the prediction missed:** that a change can be dangerous because of code it does
  not touch. I predicted the components that would change; the real problem was in one
  that did not.

---

### Change 3 — Digest

**What it actually affected**

| Where | What |
| --- | --- |
| `notifications.js:107` | **`routeMessage()` itself.** A third stage and a `delivery: 'none' \| 'immediate' \| 'digest'` field. |
| `notifications.js` | `DEFAULT_DIGEST`, `sanitizeDigest()`. |
| `store.js` | `prefs.digest`; held entries carry `pending`; `listNotifications` hides them; `flushDigest`, `usersDueForDigest`; `nextDueAt` now considers digests too. |
| `scheduler.js` | One new hook, `onSweep` — **the scheduler from change 2, reused unchanged.** |
| `routes.js` | Held items are stored but not pushed; `flushDigests`; `PATCH /api/settings/digest`. |
| **outside the boundary:** `public/` | A settings section and a summary entry that lists what it collected. |

**Rounds of instruction:** two. The second was forced by two failing tests, one of which
was a real bug.

**Where I intervened:** I did not. The instruction was to carry on to the end of what could be
done without me, and I checked the result rather than the process.

**What was easy, what was hard**

- **The prediction was right on all three counts.** This is the only change that modified
  the decision function; it reused change 2's scheduler without altering it (which is why
  the assignment insists on the order); and **the collision with quiet hours happened.**
- **The collision, and how it resolved.** Both features mean "hold this back", by different
  mechanisms. The answer is that quiet hours are evaluated **at flush time and applied to
  the digest as one notification** — not to each held item as it arrives. Nothing in the
  per-item decision could have produced that answer, because at hold time there is no
  digest yet to silence.
- **A real bug the tests caught.** Turning the digest *off* stranded everything it was
  holding, forever: the release path only looked at users who still had the digest enabled,
  and by then this user did not. Held items would have become invisible permanently. Found
  by asserting the released count, not by reading the code.
- **Easy — that batching did not disturb anything else.** A held mention still counts
  unread and still ignores a channel mute, with no new code. Both invariants survived a
  third delivery mode for the same reason they survived the first two: the mute was never
  load-bearing, and unread was never a function of notifications.

---

## What the three changes say about the boundary

Ranked by how much each one touched the notification system:

| Change | Touched `routeMessage()` | Where the work actually was |
| --- | --- | --- |
| 2 · Scheduled | not one line | new infrastructure, and a latent persistence bug |
| 1 · Snooze | one line (threading `now`) | the client, keeping a lapsed mute from looking live |
| 3 · Digest | yes — a third stage | inside the boundary, plus reusing change 2's scheduler |

The requirement that sounded most like a notification feature (scheduled messages) was the
one that touched it least.
