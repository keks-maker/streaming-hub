// Kachel von „Jetzt & Gleich“: die Senderkachel (livetv-tile.js, docs/DESIGN.md „Senderkachel“) mit der laufenden
// Sendung in der Medienfläche und dem Infobereich, dazu „Danach“-Zeilen für nächste und übernächste Sendung und
// runde Aufnahme-Knöpfe (laufende Sendung oben rechts in der Medienfläche, kommende je in ihrer Zeile).
//
// Reine DOM-Sicht ohne Daten- oder Aufnahme-Logik. Die Einträge (cur/next/after) sind kompatibel zu
// updateRowNode aus epg-row-dom.js: dieselbe Fortschritts-, Marker- und Toggle-Logik wie Liste und Kanalansicht.
// Fremdtexte nur per textContent.

'use strict';

const model = require('./epg-view-model.js');
const { h } = require('./epg-dom.js');
const gridModel = require('./epg-grid-model.js');
const { formatRemainingMinutes } = require('./livetv-tile.js');

const EMPTY_NO_PROGRAMME = 'Kein Programm in den nächsten Stunden';
const EMPTY_NO_EPG = 'Kein EPG im Cache';
const EMPTY_NO_CURRENT = 'Keine laufende Sendung';
const EMPTY_FILTERED = '–';

function recordButton(row, small) {
  const toggle = h('button', { className: `epg-toggle epg-jrec${small ? ' is-small' : ''}`, type: 'button' });
  toggle.dataset.rowId = row.id;
  return toggle;
}

function detachedRefs() {
  return { sub: h('span'), bar: h('span'), barFill: h('span'), pastNote: h('span') };
}

/** Kachel eines Senders: Gerüst mit Medienfläche (Logo-Platte als Kopf-Knopf), Infobereich und Zeilen füllt fillTile. */
function createTile(channel, kit) {
  const ch = channel.channel;
  const name = ch.name || channel.key;
  const root = h('div', { className: 'dashboard-tile dashboard-tv-tile epg-jtile', attrs: { role: 'listitem' } });
  root.style.setProperty('--tile-color', 'var(--area-livetv)');
  root.dataset.channelKey = channel.key;
  // Ersatz ohne Logo: zwei Zeichen des Senderkürzels („KA“ für „Kabel Eins“), wie die Logo-Platte der früheren Ansicht
  const fallbackText = [...gridModel.channelBadge(name).abbr].slice(0, 2).join('');
  const media = kit.createMedia(ch, { logoTag: 'button', fallbackText });
  const chan = media.querySelector('.tv-tile-logo');
  chan.classList.add('epg-jchan');
  chan.setAttribute('aria-label', `Alle Sendungen von ${name}`);
  chan.title = `Alle Sendungen von ${name}`;
  const info = h('div', { className: 'tv-tile-info' });
  root.append(media, info);
  kit.attachPreview(root, ch);
  return { el: root, media, info, chan, name, cells: [null, null, null], sig: '' };
}

/** „Danach“-Zeile: Vorschaubild (64×36, Bild setzt setCellThumb), Marker, Zeit und Titel (Ellipse), Aufnahme-Knopf. */
function upcomingLine(row) {
  const title = row.title || '(ohne Titel)';
  const range = `${model.clock(row.start)}–${model.clock(row.stop)}`;
  const thumb = h('span', { className: 'epg-thumb', text: [...title.trim()][0] || '·', attrs: { 'aria-hidden': 'true' } });
  thumb.style.setProperty('--h', String(gridModel.channelBadge(row.title).hue));
  const marker = h('span', { className: 'epg-marker' });
  const open = h('button', {
    className: 'epg-row-open epg-jnext-open',
    type: 'button',
    attrs: { 'aria-label': `Danach ${range}: ${title}` },
  }, [
    h('span', { className: 'epg-jnext-time', text: `Danach ${range}` }),
    h('span', { className: 'epg-jnext-sep', text: ' · ' }),
    h('span', { className: 'epg-jnext-title', text: title }),
  ]);
  open.title = row.title;
  open.dataset.rowId = row.id;
  const toggle = recordButton(row, true);
  const line = h('div', { className: 'epg-jnext', attrs: { role: 'group' } }, [thumb, marker, open, toggle]);
  line.dataset.rowId = row.id;
  if (row.genre) line.dataset.g = row.genre;
  return { el: line, refs: { ...detachedRefs(), marker, toggle, open, thumb, flag: null, chan: null, hint: null }, iconOnly: true, sig: '', row };
}

/**
 * Inhalt der Kachel für die aktuelle Zuordnung neu aufbauen (nur bei geänderter Zuordnung). Setzt tile.cells =
 * [laufend, nächste, übernächste] (Einträge oder null). Medienfläche und Logo bleiben stehen, damit Vorschau und Bild
 * bei einem Wechsel nur der übrigen Sendungen nicht flackern; wechselt die laufende Sendung, entfällt das Bild.
 */
function fillTile(tile, channel, assignment, { filtered, kit }) {
  const { current, next, after } = assignment;
  const prevId = tile.el.dataset.rowId || '';
  tile.cells = [null, null, null];
  tile.media.querySelector('.tv-tile-time')?.remove();
  tile.media.querySelector('.epg-marker')?.remove();
  tile.el.querySelector(':scope > .dashboard-tv-progress')?.remove();
  tile.info.textContent = '';
  // Zustand der Zuordnung zurücksetzen (updateRowNode setzt ihn nur, solange es eine laufende Sendung gibt)
  tile.el.classList.remove('is-now', 'is-past', 'is-next', 'is-selected');
  delete tile.el.dataset.phase;
  tile.el.classList.toggle('has-current', !!current);
  if (current && current.genre) tile.el.dataset.g = current.genre;
  else delete tile.el.dataset.g;

  const meta = h('span', { className: 'tv-tile-meta' });
  meta.appendChild(document.createTextNode(tile.name));
  const sub = h('span', { className: 'epg-time-sub' });
  meta.appendChild(sub);

  if (current) {
    tile.el.dataset.rowId = current.id;
    if (prevId !== current.id) {
      delete tile.el.dataset.epgImage;
      kit.setImage(tile.el, '');
    }
    tile.media.appendChild(h('span', { className: 'tv-tile-time', text: `${model.clock(current.start)} – ${model.clock(current.stop)}` }));
    const marker = h('span', { className: 'epg-marker' });
    const toggle = recordButton(current, false);
    tile.media.appendChild(marker);
    const open = h('button', { className: 'epg-row-open tv-tile-title', type: 'button', text: current.title || '(ohne Titel)' });
    open.title = current.title;
    open.dataset.rowId = current.id;
    // Reihenfolge im DOM = Tab-Reihenfolge (Titel, dann Aufnehmen); der Knopf sitzt per CSS oben rechts in der Medienfläche.
    tile.info.append(open, toggle, meta);
    const bar = kit.createProgress(0);
    bar.hidden = true;
    tile.el.appendChild(bar);
    tile.cells[0] = {
      el: tile.el,
      refs: { ...detachedRefs(), sub, bar, barFill: bar.firstChild, marker, toggle, open, flag: null, chan: tile.chan, hint: null },
      iconOnly: true,
      minutesLabel: minutes => ` · ${formatRemainingMinutes(minutes)}`, // Trenner wie bei den LiveTV-Favoriten: „Sender · noch X Min.“
      sig: '',
      row: current,
    };
  } else {
    delete tile.el.dataset.rowId;
    delete tile.el.dataset.epgImage;
    kit.setImage(tile.el, '');
    let text = EMPTY_NO_CURRENT;
    if (filtered) text = EMPTY_FILTERED;
    else if (!channel.rows.length) text = channel.hasEpg ? EMPTY_NO_PROGRAMME : EMPTY_NO_EPG;
    tile.info.append(h('span', { className: 'tv-tile-title is-empty', text, attrs: { title: text } }), meta);
  }

  [next, after].forEach((row, i) => {
    if (!row) return;
    const line = upcomingLine(row);
    tile.cells[i + 1] = line;
    tile.info.appendChild(line.el);
  });
}

module.exports = { createTile, fillTile };
