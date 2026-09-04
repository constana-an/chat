/**
 * The only scheduler in the app.
 *
 * Before this, the server had no notion of "later" at all -- the sole timers
 * were the SSE keep-alive and the save debounce, neither of which is a clock.
 *
 * It holds one timer, not one per item: it sleeps until the soonest due thing,
 * does everything that has come due, and re-arms. The wait is capped so a
 * suspended laptop or a clock jump cannot strand a message forever -- the
 * worst case is that it arrives one tick late rather than never.
 */

const MAX_WAIT_MS = 30_000;

export function createScheduler({ store, onDue, onSweep = () => {}, maxWaitMs = MAX_WAIT_MS, log = console }) {
  let timer = null;
  let running = false;

  function armNext(now = Date.now()) {
    clearTimeout(timer);
    const next = store.nextDueAt();
    if (next == null) return null;

    const wait = Math.min(maxWaitMs, Math.max(0, next - now));
    timer = setTimeout(tick, wait);
    // Never hold the process open just because something is scheduled.
    timer.unref?.();
    return wait;
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const item of store.dueScheduled(Date.now())) {
        try {
          await onDue(item);
          store.completeScheduled(item.id);
        } catch (err) {
          // A scheduled send can fail for reasons that did not exist when it
          // was written -- the author left the channel, the channel is gone.
          // Keep the failure so the author can see why nothing arrived.
          store.failScheduled(item.id, err.message);
          log.warn?.(`[scheduler] ${item.id} could not be delivered: ${err.message}`);
        }
      }
      // Anything else that runs on the clock — currently the digests.
      await onSweep(Date.now());
    } finally {
      running = false;
      armNext();
    }
  }

  return {
    /** Called at boot, after the store has loaded, so restarts recover. */
    start() {
      const pending = store.dueScheduled(Number.POSITIVE_INFINITY).length;
      if (pending) log.log?.(`[scheduler] ${pending} scheduled message(s) restored`);
      return armNext();
    },
    armNext,
    /** Exposed so tests can force a pass without waiting on wall-clock time. */
    tick,
    stop() {
      clearTimeout(timer);
      timer = null;
    },
  };
}
