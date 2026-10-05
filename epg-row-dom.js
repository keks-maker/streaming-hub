// Sendungszeile des Programmführers (Etappe 3.3 Liste, 3.4 Kanalansicht): ein Knotenaufbau und eine
// Aktualisierung für beide Ansichten — Marker, Fortschritt, Toggle-Beschriftung (Aufnehmen/Abbrechen/
// Stoppen) kommen immer aus demselben Code. Die Aktionen (Planen, Rückfrage, Stoppen) liegen in
// epg-view.js; hier wird nur dargestellt. Fremdtexte nur per textContent.
//
// Varianten:
//   'list'    Zeile der virtualisierten Programmliste (Spalte „Sender“ mit Link in die Kanalansicht)
//   'channel' Zeile der Kanalansicht (ohne Senderspalte; Kennzeichen „Jetzt“/„Nächste“)

'use strict';

const model = require('./epg-view-model.js');
const { h } = require('./epg-dom.js');
const { genreLabel } = require('./epg-genres.js');

function senderName(row) {
  return row.channel.name || row.channelKey;
}

/** Knoten einer Sendung → { el, refs, sig, variant }. */
function createRowNode(row, { variant = 'list' } = {}) {
  const channelVariant = variant === 'channel';
  const marker = h('span', { className: 'epg-marker' });
  const time = h('span', { className: 'epg-time', text: channelVariant ? `${model.clock(row.start)}–${model.clock(row.stop)}` : model.clock(row.start) });
  const timeLine = h('div', { className: 'epg-time-line' }, [time]);
  if (row.night) timeLine.appendChild(h('span', { className: 'epg-night', text: 'Nacht', attrs: { title: 'Nach Mitternacht (Vorabend-TV-Tag)' } }));
  const sub = h('span', { className: 'epg-time-sub' });
  const barFill = h('span', { className: 'epg-progress-fill' });
  const bar = h('span', { className: 'epg-progress', hidden: true }, [barFill]);
  const timeCell = h('div', { className: 'epg-col-time' }, [timeLine, sub, bar]);
  const open = h('button', { className: 'epg-row-open', type: 'button', text: row.title || '(ohne Titel)' });
  open.title = row.title;
  const flag = channelVariant ? h('span', { className: 'epg-flag', hidden: true }) : null;
  const titleCell = h('div', { className: 'epg-col-title' }, flag ? [flag, open] : [open]);
  const label = genreLabel(row.genre);
  const genreCell = h('div', { className: `epg-col-genre${label ? '' : ' is-none'}`, text: label || '–' });
  const durCell = h('div', { className: 'epg-col-dur', text: `${model.durationMinutes(row.start, row.stop)} min` });
  const toggle = h('button', { className: 'epg-toggle', type: 'button' });
  const pastNote = h('span', { className: 'epg-past-note', text: 'vorbei', hidden: true });
  // Kanalansicht: Hinweis „Planung nur bis 8 Tage im Voraus“ sichtbar neben dem deaktivierten Button (P9)
  const hint = channelVariant ? h('span', { className: 'epg-row-hint', hidden: true }) : null;
  const actionCell = h('div', { className: 'epg-col-action' }, hint ? [hint, toggle, pastNote] : [toggle, pastNote]);
  const cells = [h('div', { className: 'epg-col-mk' }, [marker]), timeCell];
  let chan = null;
  if (!channelVariant) {
    // Sendername: Einstieg in die Kanalansicht (Tastatur Enter/Space über das Button-Element)
    chan = h('button', {
      className: 'epg-chan-link',
      type: 'button',
      text: senderName(row),
      attrs: { 'aria-label': `Alle Sendungen von ${senderName(row)}`, title: `Alle Sendungen von ${senderName(row)}` },
    });
    cells.push(h('div', { className: 'epg-col-channel' }, [chan]));
  }
  cells.push(titleCell, genreCell, durCell, actionCell);
  const el = h('div', { className: channelVariant ? 'epg-crow epg-program' : 'epg-list-row epg-program', attrs: { role: 'listitem' } }, cells);
  el.dataset.rowId = row.id;
  if (label) el.dataset.g = row.genre;
  return { el, refs: { sub, bar, barFill, marker, toggle, pastNote, open, flag, chan, hint }, sig: '', variant };
}

function markerTitle(marker) {
  if (!marker) return '';
  if (marker.stopping) return 'Aufnahme wird beendet';
  return marker.state === 'recording' ? 'Aufnahme läuft' : 'Aufnahme geplant';
}

/**
 * Aktualisiert Klassen, Fortschritt, Marker und Toggle einer Zeile; nichts, wenn sich nichts geändert hat
 * (Signatur). marker: grid.matchMarkers-Ergebnis; flag: 'now' | 'next' | '' (nur Kanalansicht).
 */
function updateRowNode(entry, row, { nowMs, marker, selected, flag = '' }) {
  const info = model.rowPhase(row, nowMs);
  const toggle = model.toggleState({ row, marker, nowMs });
  const minutesText = info.minutesLeft ? `noch ${info.minutesLeft} min` : '';
  const percent = Math.round(info.progress * 100);
  const sig = [info.phase, minutesText, percent, marker ? marker.state : '', marker && marker.stopping ? 's' : '', toggle.kind, toggle.disabled, selected, flag].join('|');
  if (entry.sig === sig) return false;
  entry.sig = sig;
  const { el, refs } = entry;
  el.classList.toggle('is-now', info.phase === 'now');
  el.classList.toggle('is-past', info.phase === 'past');
  el.classList.toggle('is-next', flag === 'next');
  el.classList.toggle('is-selected', selected);
  el.dataset.phase = info.phase;
  refs.sub.textContent = minutesText;
  refs.bar.hidden = info.phase !== 'now';
  refs.barFill.style.width = `${percent}%`;
  if (refs.flag) {
    refs.flag.hidden = !flag;
    refs.flag.dataset.flag = flag;
    refs.flag.textContent = flag === 'now' ? 'Jetzt' : flag === 'next' ? 'Nächste' : '';
  }
  refs.marker.dataset.state = marker ? (marker.stopping ? 'stopping' : marker.state) : '';
  refs.marker.textContent = marker ? '●' : '';
  refs.marker.title = markerTitle(marker);
  refs.marker.setAttribute('aria-label', refs.marker.title);
  // Vergangene Sendungen: statt des Buttons „vorbei“ (wie im Mockup); die Zukunftsregel-Meldung bleibt im Detail
  const pastOnly = info.phase === 'past' && toggle.kind === 'record';
  refs.toggle.hidden = pastOnly;
  refs.pastNote.hidden = !pastOnly;
  refs.toggle.textContent = toggle.label;
  refs.toggle.dataset.kind = toggle.kind;
  refs.toggle.disabled = toggle.disabled;
  refs.toggle.title = toggle.hint;
  if (refs.hint) {
    refs.hint.textContent = toggle.hint;
    refs.hint.hidden = !toggle.hint;
  }
  refs.toggle.setAttribute(
    'aria-label',
    `${toggle.label.replace(/^[●✕■]\s*/, '')}: ${row.title} (${senderName(row)}, ${model.clock(row.start)})`,
  );
  return true;
}

module.exports = { createRowNode, updateRowNode };
