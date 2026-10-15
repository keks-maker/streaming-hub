'use strict';

// Zeitplan der automatischen Feed-Prüfung: einmal kurz nach dem Start, danach im eingestellten Intervall
// (Einstellung refreshIntervalMinutes, 30/60/120 min). Eine geänderte Einstellung gilt ab dem nächsten reschedule().
// Timer sind injizierbar (Tests).

const MIN_INTERVAL_MINUTES = 30;
const START_DELAY_MS = 20 * 1000;

function intervalMs(minutes) {
  const value = Number(minutes);
  return Math.max(MIN_INTERVAL_MINUTES, Number.isFinite(value) ? value : 60) * 60 * 1000;
}

/** options: run() (Prüfung), getIntervalMinutes(), startDelayMs, setTimer/clearTimer/setTick/clearTick. */
function createRefreshSchedule({ run, getIntervalMinutes, startDelayMs = START_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout, setTick = setInterval, clearTick = clearInterval }) {
  let startTimer = null;
  let tick = null;
  let currentMs = 0;

  const unref = handle => {
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  };

  function armInterval() {
    if (tick) clearTick(tick);
    currentMs = intervalMs(getIntervalMinutes());
    tick = unref(setTick(run, currentMs));
  }

  function start() {
    stop();
    startTimer = unref(
      setTimer(() => {
        startTimer = null;
        run();
      }, startDelayMs),
    );
    armInterval();
  }

  /** Nach geänderter Einstellung: neues Intervall übernehmen (nur wenn es sich geändert hat). */
  function reschedule() {
    if (!tick) return;
    if (intervalMs(getIntervalMinutes()) !== currentMs) armInterval();
  }

  function stop() {
    if (startTimer) clearTimer(startTimer);
    if (tick) clearTick(tick);
    startTimer = null;
    tick = null;
  }

  return { start, reschedule, stop, getIntervalMs: () => currentMs };
}

module.exports = { createRefreshSchedule, intervalMs, MIN_INTERVAL_MINUTES, START_DELAY_MS };
