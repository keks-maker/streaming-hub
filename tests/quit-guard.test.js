'use strict';

process.env.TZ = 'Europe/Berlin';

// Tests: Beenden-Dialog bei anstehender Planung (Etappe 2b; Konzept §3.5, E2).
// Reine Entscheidungslogik (quit-guard.js, planned-summary.js), Bereinigung
// (sanitizeLabel/clampText) und der Ablauf im QuitCoordinator mit Attrappen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setImmediate } = require('node:timers');
const { buildQuitPrompt, choiceFromResponse } = require('../lib/recorder/quit-guard.js');
const { plansWithinHorizon, formatPlannedTime, plannedName } = require('../lib/recorder/planned-summary.js');
const { QuitCoordinator } = require('../lib/recorder/QuitCoordinator.js');
const { clampText, sanitizeLabel } = require('../lib/recorder/schedule-ui-model.js');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-10-05T12:00:00+02:00');

function entry(over = {}) {
  return {
    id: 'sch_a',
    channelId: 'das-erste',
    channelName: 'Das Erste',
    title: 'Tagesschau',
    epgStart: '2026-10-05T20:15:00+02:00',
    epgStop: '2026-10-05T20:30:00+02:00',
    state: 'scheduled',
    ...over,
  };
}

test('keine Planung → kein Dialog', () => {
  assert.equal(buildQuitPrompt({ entries: [], nowMs: NOW }), null);
});

test('Planung heute 20:15 → Text laut Konzept, zwei Buttons', () => {
  const p = buildQuitPrompt({ entries: [entry()], nowMs: NOW });
  assert.equal(p.options.message, 'Es ist eine Aufnahme geplant: Das Erste — Tagesschau, heute 20:15. Streaming Hub muss dafür laufen.');
  assert.deepEqual(p.options.buttons, ['Im Hintergrund behalten', 'Trotzdem beenden']);
  assert.equal(p.options.defaultId, 0);
  assert.equal(choiceFromResponse(0), 'keep');
  assert.equal(choiceFromResponse(1), 'quit');
  assert.equal(choiceFromResponse(undefined), 'keep');
});

test('24-h-Grenze exakt: genau jetzt + 24 h zählt, 1 ms danach nicht', () => {
  const at = ms => new Date(ms).toISOString();
  const onLimit = entry({ epgStart: at(NOW + 24 * HOUR), epgStop: at(NOW + 25 * HOUR) });
  const past = entry({ epgStart: at(NOW + 24 * HOUR + 1), epgStop: at(NOW + 25 * HOUR) });
  assert.ok(buildQuitPrompt({ entries: [onLimit], nowMs: NOW }));
  assert.equal(buildQuitPrompt({ entries: [past], nowMs: NOW }), null);
  assert.equal(plansWithinHorizon([onLimit, past], NOW).length, 1);
});

test('nur geplante zählen: abgesagt/erledigt/verpasst/fehlgeschlagen/laufend und beendete Sendungen werden ignoriert', () => {
  const entries = ['cancelled', 'done', 'missed', 'failed', 'recording'].map((state, i) => entry({ id: `sch_${i}`, state }));
  entries.push(entry({ id: 'sch_over', epgStart: '2026-10-05T10:00:00+02:00', epgStop: '2026-10-05T11:00:00+02:00' })); // Ende vorbei
  assert.equal(buildQuitPrompt({ entries, nowMs: NOW }), null);
});

test('begonnene, noch nicht gestartete Planung (Ende in der Zukunft) zählt', () => {
  const e = entry({ epgStart: '2026-10-05T11:55:00+02:00', epgStop: '2026-10-05T12:30:00+02:00' });
  assert.ok(buildQuitPrompt({ entries: [e], nowMs: NOW }));
});

test('Mehrfach-Planung: die nächste wird genannt, Rest als Zahl; laufende Aufnahme im Detail', () => {
  const entries = [
    entry({ id: 'sch_late', title: 'Spät', epgStart: '2026-10-05T22:00:00+02:00', epgStop: '2026-10-05T23:00:00+02:00' }),
    entry({ id: 'sch_next', title: 'Zuerst', epgStart: '2026-10-05T13:30:00+02:00', epgStop: '2026-10-05T14:00:00+02:00' }),
    entry({ id: 'sch_far', title: 'Übermorgen', epgStart: '2026-10-08T22:00:00+02:00', epgStop: '2026-10-08T23:00:00+02:00' }),
  ];
  const p = buildQuitPrompt({ entries, nowMs: NOW, activeRecordings: 2 });
  assert.equal(p.entryId, 'sch_next');
  assert.match(p.options.message, /Das Erste — Zuerst, heute 13:30\./);
  assert.match(p.options.detail, /Weitere Planungen in den nächsten 24 Stunden: 1\./);
  assert.match(p.options.detail, /2 Aufnahmen/);
});

test('Tageswort: heute/morgen/Datum; Mitternacht und Sommerzeitwechsel (Europe/Berlin)', () => {
  assert.equal(formatPlannedTime(Date.parse('2026-10-05T23:59:00+02:00'), NOW), 'heute 23:59');
  assert.equal(formatPlannedTime(Date.parse('2026-10-06T00:00:00+02:00'), NOW), 'morgen 00:00');
  assert.equal(formatPlannedTime(Date.parse('2026-10-07T06:05:00+02:00'), NOW), 'Mi 07.10. 06:05');
  // Zeitumstellung 25.10.2026 (Ende Sommerzeit): „morgen“ bleibt kalendarisch korrekt
  const before = Date.parse('2026-10-24T22:00:00+02:00');
  assert.equal(formatPlannedTime(Date.parse('2026-10-25T20:15:00+01:00'), before), 'morgen 20:15');
});

test('Dialog-Text ist bereinigt: Steuerzeichen raus, Länge gekürzt', () => {
  const evil = entry({ channelName: 'Sender\u0007\nZwei', title: `Titel‮umgedreht\r\n${'x'.repeat(200)}` });
  const { message } = buildQuitPrompt({ entries: [evil], nowMs: NOW }).options;
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f‮]/.test(message));
  assert.ok(message.length < 200, `Text bleibt kurz (${message.length})`);
  assert.match(message, /Sender Zwei — Titel umgedreht x+…, heute/);
});

test('clampText/sanitizeLabel: kein halbes Surrogatzeichen an der Grenze, Länge ≤ max', () => {
  const emoji = '😀'.repeat(10); // 20 UTF-16-Einheiten
  for (let max = 2; max <= 21; max += 1) {
    const out = clampText(emoji, max);
    assert.ok(out.length <= max, `max ${max}: ${out.length}`);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out), `max ${max}: halbes Surrogat`);
  }
  assert.equal(clampText('abcdefghij', 5), 'abcd…');
  assert.equal(clampText('kurz', 300), 'kurz');
  assert.equal(clampText(null, 10), '');
  const s = sanitizeLabel(`a${'😀'.repeat(60)}`, 11);
  assert.ok(s.length <= 11 && s.endsWith('…'));
  assert.equal(sanitizeLabel(' a \t\u0000 b​c d ', 50), 'a b c d');
  assert.equal(plannedName({ channelName: '', channelId: '', title: '' }), 'Sender');
});

// ── QuitCoordinator ──

function makeCoordinator({ entries = [entry()], activeCount = 0, response = 0, askError = null, now = NOW } = {}) {
  const clock = { t: now };
  const calls = { quit: 0, dialogs: [], closed: 0 };
  const win = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    close() {
      calls.closed += 1;
      // echtes Fenster: 'close' → Handler
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      const stopped = coordinator.handleWindowClose(event, win);
      if (!stopped) this.destroyed = true;
    },
  };
  const state = { response };
  const coordinator = new QuitCoordinator({
    app: { quit: () => { calls.quit += 1; } },
    askDialog: async (w, options) => {
      calls.dialogs.push({ w, options });
      if (askError) throw askError;
      return { response: state.response };
    },
    getEntries: () => entries,
    getActiveCount: () => activeCount,
    getWindow: () => (win.destroyed ? null : win),
    now: () => clock.t,
  });
  const ev = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  return { coordinator, calls, win, state, clock, ev };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('Quit ohne Planung: still (kein Dialog), Cleanup darf laufen', () => {
  const { coordinator, calls, ev } = makeCoordinator({ entries: [] });
  const e = ev();
  assert.equal(coordinator.handleBeforeQuit(e), false);
  assert.equal(e.prevented, false);
  assert.equal(calls.dialogs.length, 0);
});

test('Quit mit Planung < 24 h: Quit wird abgefangen, „Trotzdem beenden“ → app.quit(), zweiter Durchlauf ohne Dialog', async () => {
  const { coordinator, calls, ev } = makeCoordinator({ response: 1 });
  const e = ev();
  assert.equal(coordinator.handleBeforeQuit(e), true);
  assert.equal(e.prevented, true);
  await tick();
  assert.equal(calls.dialogs.length, 1);
  assert.equal(calls.quit, 1);
  const e2 = ev();
  assert.equal(coordinator.handleBeforeQuit(e2), false, 'bestätigt: Cleanup läuft');
  assert.equal(e2.prevented, false);
  assert.equal(calls.dialogs.length, 1, 'kein zweiter Dialog');
});

test('Quit + „Im Hintergrund behalten“: kein app.quit(), Hauptfenster wird geschlossen (App bleibt im Tray)', async () => {
  const { coordinator, calls, win, ev } = makeCoordinator({ response: 0 });
  assert.equal(coordinator.handleBeforeQuit(ev()), true);
  await tick();
  assert.equal(calls.quit, 0);
  assert.equal(calls.closed, 1);
  assert.equal(win.destroyed, true, 'Fenster-close wird nicht erneut abgefangen');
  assert.equal(calls.dialogs.length, 1);
});

test('Fenster-X: Dialog; „behalten“ schließt das Fenster ohne zweiten Dialog, „beenden“ → app.quit()', async () => {
  const keep = makeCoordinator({ response: 0 });
  const e = keep.ev();
  assert.equal(keep.coordinator.handleWindowClose(e, keep.win), true);
  assert.equal(e.prevented, true);
  await tick();
  assert.equal(keep.calls.dialogs.length, 1);
  assert.equal(keep.win.destroyed, true);
  assert.equal(keep.calls.quit, 0);

  const quit = makeCoordinator({ response: 1 });
  quit.coordinator.handleWindowClose(quit.ev(), quit.win);
  await tick();
  assert.equal(quit.calls.quit, 1);
  const e3 = quit.ev();
  assert.equal(quit.coordinator.handleWindowClose(e3, quit.win), false, 'beim folgenden Quit schließt das Fenster ohne Dialog');
});

test('kein doppelter Dialog: Fenster-X und gleichzeitig Cmd+Q, doppeltes Cmd+Q', async () => {
  const ctx = makeCoordinator({ response: 0 });
  const e1 = ctx.ev();
  const e2 = ctx.ev();
  const e3 = ctx.ev();
  assert.equal(ctx.coordinator.handleWindowClose(e1, ctx.win), true);
  assert.equal(ctx.coordinator.handleBeforeQuit(e2), true);
  assert.equal(e2.prevented, true, 'Quit während offenem Dialog wird verschluckt');
  assert.equal(ctx.coordinator.handleBeforeQuit(e3), true);
  await tick();
  assert.equal(ctx.calls.dialogs.length, 1);
});

test('Updater-Relaunch, System-Shutdown und bestätigtes Beenden blockiert der Dialog nie', () => {
  const updater = makeCoordinator();
  updater.coordinator.allowQuit('updater');
  assert.equal(updater.coordinator.handleBeforeQuit(updater.ev()), false);
  assert.equal(updater.coordinator.handleWindowClose(updater.ev(), updater.win), false);
  assert.equal(updater.calls.dialogs.length, 0);

  const shutdown = makeCoordinator();
  shutdown.coordinator.markSystemShutdown();
  assert.equal(shutdown.coordinator.handleBeforeQuit(shutdown.ev()), false);
  assert.equal(shutdown.calls.dialogs.length, 0);
  // Das Flag ist kurzlebig (macOS-Dialog „Abbrechen“ lässt den Shutdown ausfallen): nach 60 s fragt Cmd+Q wieder
  const cancelled = makeCoordinator();
  cancelled.coordinator.markSystemShutdown();
  cancelled.clock.t += 61 * 1000;
  const later = cancelled.ev();
  assert.equal(cancelled.coordinator.handleBeforeQuit(later), true);
  assert.equal(later.prevented, true);
});

test('Dialog fehlgeschlagen: kein Blockieren — der Quit läuft durch', async () => {
  const ctx = makeCoordinator({ askError: new Error('kein Dialog') });
  assert.equal(ctx.coordinator.handleBeforeQuit(ctx.ev()), true);
  await tick();
  assert.equal(ctx.calls.quit, 1);
});

test('Tray-Beenden mit Aufnahme: confirmQuit() fragt einmal, danach keine Doppelung durch before-quit', async () => {
  const ctx = makeCoordinator({ response: 1 });
  assert.equal(await ctx.coordinator.confirmQuit(), true);
  assert.equal(ctx.coordinator.handleBeforeQuit(ctx.ev()), false);
  assert.equal(ctx.calls.dialogs.length, 1);

  const keep = makeCoordinator({ response: 0 });
  assert.equal(await keep.coordinator.confirmQuit(), false);
  const none = makeCoordinator({ entries: [] });
  assert.equal(await none.coordinator.confirmQuit(), true);
  assert.equal(none.calls.dialogs.length, 0);
});

test('Quellcode-Invarianten: Updater-Relaunch gibt den Quit frei, before-quit fragt zuerst, Cleanup danach', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.equal((main.match(/quitCoordinator\.allowQuit\('updater'\)/g) || []).length, 2);
  const bq = main.slice(main.indexOf("app.on('before-quit'"));
  assert.ok(bq.indexOf('handleBeforeQuit') < bq.indexOf('quitSweep'), 'Dialog vor Quit-Cleanup');
  assert.match(main, /createdWindow\.on\('close'/);
  assert.match(main, /powerMonitor\.on\('shutdown', \(\) => quitCoordinator\.markSystemShutdown\(\)\)/);
  // Test-Hook nur im isolierten Testmodus
  assert.match(main, /process\.env\.STREAMING_HUB_USER_DATA && process\.env\.STREAMING_HUB_TEST_QUIT_DIALOG === 'mock'/);
});
