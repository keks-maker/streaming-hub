// Tray-Menü-Modell (Etappe 2b; Konzept §3.5, E3): reine Funktion ohne Electron.
// Liefert Beschreibungen {id, label, enabled?, type?, recId?}; der TrayController
// hängt die Click-Handler an. Dadurch sind Reihenfolge, Texte und Bereinigung
// (Länge, Steuerzeichen) ohne Electron testbar.
//
// E3: Das Tray-Icon bleibt im Leerlauf violett (auch mit Planung), ROT nur bei
// laufender Aufnahme — `trayIconKind`. Geplantes erscheint nur als Menüeintrag.

'use strict';

const { sanitizeLabel } = require('./schedule-ui-model.js');
const { pendingPlans, formatPlannedTime, plannedName } = require('./planned-summary.js');

const MAX_PLANNED_ITEMS = 3;

function trayIconKind(activeCount) {
  return activeCount > 0 ? 'rec' : 'idle';
}

/**
 * options:
 * - jobs: [{ recId, channelName, channelId, epgTitle, elapsedText }] laufende Aufnahmen
 * - planned: Planungseinträge (alle; gefiltert wird hier), nowMs
 * - hasStorageRoot, hasLibrary, hasPlanning: Aktionen anbieten
 */
function buildTrayMenuModel({ jobs = [], planned = [], nowMs, hasStorageRoot = false, hasLibrary = false, hasPlanning = false } = {}) {
  const items = [];
  for (const job of jobs) {
    const channel = sanitizeLabel(job.channelName || job.channelId || 'Kanal', 40) || 'Kanal';
    const title = sanitizeLabel(job.epgTitle, 60);
    items.push({
      id: 'job',
      recId: job.recId,
      label: `● ${channel}${title ? ' — ' + title : ''} · ${job.elapsedText}`,
      enabled: false, // reine Statuszeile
    });
    items.push({ id: 'job-stop', recId: job.recId, label: '  ⏹ Aufnahme stoppen' });
  }
  if (jobs.length) items.push({ type: 'separator' });

  const plans = pendingPlans(planned, nowMs);
  if (plans.length) {
    for (const plan of plans.slice(0, MAX_PLANNED_ITEMS)) {
      items.push({
        id: 'planned',
        entryId: plan.entry.id,
        label: `Geplant: ${plannedName(plan.entry)} · ${formatPlannedTime(plan.startMs, nowMs)}`,
        enabled: false,
      });
    }
    if (plans.length > MAX_PLANNED_ITEMS) {
      items.push({ id: 'planned-more', label: `… und ${plans.length - MAX_PLANNED_ITEMS} weitere geplant`, enabled: false });
    }
  }
  if (hasPlanning) items.push({ id: 'open-planning', label: 'Planung öffnen' });
  if (plans.length || hasPlanning) items.push({ type: 'separator' });

  if (hasStorageRoot) items.push({ id: 'open-folder', label: 'Aufnahmen-Ordner öffnen' });
  items.push({ id: 'open-app', label: 'App öffnen' });
  if (hasLibrary) items.push({ id: 'open-library', label: 'Aufnahmen-Bibliothek' });
  items.push({ type: 'separator' });
  items.push(jobs.length ? { id: 'quit-confirm', label: 'Beenden …' } : { id: 'quit', label: 'Beenden' });
  return items;
}

module.exports = { buildTrayMenuModel, trayIconKind, MAX_PLANNED_ITEMS };
