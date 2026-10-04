// Beenden-Dialog bei anstehender Planung (Etappe 2b; Konzept §3.5, Entscheidung E2):
// reine Entscheidungslogik ohne Electron. Der Dialog erscheint nur, wenn in den
// nächsten 24 h eine Aufnahme geplant ist; sonst wird still beendet wie bisher.
//
// Semantik der Buttons (gilt für Fenster-X und Beenden):
//   [Im Hintergrund behalten] → Fenster schließen, App bleibt im Tray (Planung läuft)
//   [Trotzdem beenden]        → Quit mit dem normalen Cleanup (before-quit/quitSweep)

'use strict';

const { plansWithinHorizon, formatPlannedTime, plannedName, PLAN_HORIZON_MS } = require('./planned-summary.js');

const BUTTON_KEEP = 'Im Hintergrund behalten';
const BUTTON_QUIT = 'Trotzdem beenden';

/**
 * Liefert null (kein Dialog nötig) oder die Dialog-Optionen. Gewählt wird die
 * nächste Planung; weitere Planungen im Zeitraum und eine laufende Aufnahme
 * stehen im Detailtext.
 * entries: Planungseinträge (nur state `scheduled` zählt), activeRecordings:
 * Anzahl laufender Aufnahmen.
 */
function buildQuitPrompt({ entries, nowMs, activeRecordings = 0, horizonMs = PLAN_HORIZON_MS }) {
  const plans = plansWithinHorizon(entries, nowMs, horizonMs);
  if (!plans.length) return null;
  const next = plans[0];
  const label = `${plannedName(next.entry)}, ${formatPlannedTime(next.startMs, nowMs)}`;
  const detailParts = ['„Im Hintergrund behalten“ schließt das Fenster; Streaming Hub läuft im Tray weiter und nimmt wie geplant auf.'];
  if (plans.length > 1) {
    const more = plans.length - 1;
    detailParts.push(`Weitere Planungen in den nächsten 24 Stunden: ${more}.`);
  }
  if (activeRecordings > 0) {
    detailParts.push(
      activeRecordings === 1
        ? 'Außerdem läuft gerade eine Aufnahme; sie wird beim Beenden abgebrochen (der bisher aufgenommene Teil bleibt erhalten).'
        : `Außerdem laufen gerade ${activeRecordings} Aufnahmen; sie werden beim Beenden abgebrochen (der bisher aufgenommene Teil bleibt erhalten).`,
    );
  }
  return {
    entryId: next.entry.id,
    options: {
      type: 'question',
      buttons: [BUTTON_KEEP, BUTTON_QUIT],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: `Es ist eine Aufnahme geplant: ${label}. Streaming Hub muss dafür laufen.`,
      detail: detailParts.join('\n\n'),
    },
  };
}

/** Antwortindex des Dialogs → Aktion. Alles außer „Trotzdem beenden“ behält die App. */
function choiceFromResponse(response) {
  return response === 1 ? 'quit' : 'keep';
}

module.exports = { buildQuitPrompt, choiceFromResponse, BUTTON_KEEP, BUTTON_QUIT };
