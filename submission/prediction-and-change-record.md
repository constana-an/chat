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

**Where I intervened:** *(yours — what you pushed back on or redirected)*

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

- **What it actually affected:**
- **Rounds of instruction:**
- **Where I intervened:**
- **What was easy, what was hard, and why:**

### Change 3 — Digest

- **What it actually affected:**
- **Rounds of instruction:**
- **Where I intervened:**
- **What was easy, what was hard, and why:**
