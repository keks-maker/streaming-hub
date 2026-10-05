// LiveTV-Hub (Etappe 3.6b): zwei gleich große Einstiegskarten im LiveTV-Dashboard
// („Programmübersicht“ links, „Aufnahmen“ rechts). Die Karten zeigen nur eine Statuszeile —
// keine Senderliste, keine Vorschau. Alle Texte per textContent; das einzige innerHTML ist das
// feste, statische SVG-Icon. Daten: schedule:list / recording:list / recording:ffmpeg-status
// über die vorhandene preload-API, kein eigener IPC.
// Die Verdrahtung (Klick-Ziele, EPG-Eingabe, Aktualisierungs-Trigger) liegt in renderer.js.

'use strict';

const { recordingsCardModel, epgCardModel } = require('./dashboard-hub-model.js');

const ICON_EPG =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="20"/></svg>';
const ICON_REC =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/></svg>';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Baut das statische Gerüst einer Karte; Status und Hinweis werden später gesetzt. */
function buildCard(doc, { key, id, title, iconSvg, onOpen }) {
  const card = el(doc, 'article', `hub-card hub-card-${key}`);
  card.dataset.card = key;
  const icon = el(doc, 'span', 'hub-card-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = iconSvg;
  const body = el(doc, 'div', 'hub-card-body');
  const heading = el(doc, 'h2', 'hub-card-title');
  const main = el(doc, 'button', 'hub-card-main', title);
  main.type = 'button';
  main.id = id;
  main.addEventListener('click', onOpen);
  heading.appendChild(main);
  const status = el(doc, 'p', 'hub-card-status');
  const hint = el(doc, 'p', 'hub-card-hint');
  body.append(heading, status, hint);
  const chevron = el(doc, 'span', 'hub-card-chevron', '›');
  chevron.setAttribute('aria-hidden', 'true');
  card.append(icon, body, chevron);
  return { card, status, hint };
}

function setTone(card, status, tone) {
  status.classList.toggle('is-dim', tone === 'dim');
  status.classList.toggle('is-warn', tone === 'warn');
  card.dataset.tone = tone;
}

function dot(doc, kind) {
  const d = el(doc, 'span', kind === 'running' ? 'hub-dot hub-dot-live' : 'hub-dot hub-dot-planned');
  d.setAttribute('aria-hidden', 'true');
  return d;
}

function createDashboardHub(root, options = {}) {
  const { api, getEpgInput, onOpenEpg, onOpenRecordings, logger } = options;
  const doc = root.ownerDocument || document;

  const epg = buildCard(doc, {
    key: 'epg',
    id: 'dashboardEpgOpen',
    title: 'Programmübersicht',
    iconSvg: ICON_EPG,
    onOpen: () => onOpenEpg(),
  });
  const rec = buildCard(doc, {
    key: 'recordings',
    id: 'dashboardRecordingsOpen',
    title: 'Aufnahmen',
    iconSvg: ICON_REC,
    onOpen: () => onOpenRecordings(),
  });
  root.textContent = '';
  root.append(epg.card, rec.card);

  const data = { loaded: false, error: false, ffmpegOk: undefined, schedules: [], recordings: [] };
  let seq = 0;

  function renderEpg() {
    const input = typeof getEpgInput === 'function' ? getEpgInput() : {};
    const model = epgCardModel(input);
    epg.status.textContent = model.status;
    epg.hint.textContent = model.hint;
    epg.card.dataset.state = model.state;
    setTone(epg.card, epg.status, model.tone);
    return model;
  }

  function renderRecordings() {
    const model = recordingsCardModel(data);
    rec.status.textContent = '';
    if (model.parts.length) {
      model.parts.forEach((part, index) => {
        if (index > 0) rec.status.appendChild(doc.createTextNode(' · '));
        if (part.kind !== 'done') rec.status.appendChild(dot(doc, part.kind));
        rec.status.appendChild(doc.createTextNode(part.text));
      });
    } else {
      rec.status.textContent = model.status;
    }
    rec.hint.textContent = model.hint;
    rec.card.dataset.state = model.state;
    rec.card.classList.toggle('has-running', model.running > 0);
    setTone(rec.card, rec.status, model.tone);
    return model;
  }

  function render() {
    renderEpg();
    renderRecordings();
  }

  /** Holt Planung, Aufnahmen und (einmalig bzw. solange es fehlt) den ffmpeg-Status; veraltete Antworten werden verworfen. */
  async function refresh() {
    const mine = ++seq;
    try {
      const [schedules, recordings, ffmpeg] = await Promise.all([
        api.listSchedules(),
        api.listRecordings(),
        data.ffmpegOk === true ? Promise.resolve({ ok: true }) : api.checkFfmpegStatus().catch(() => null),
      ]);
      if (mine !== seq) return;
      data.schedules = Array.isArray(schedules) ? schedules : [];
      data.recordings = Array.isArray(recordings) ? recordings : [];
      if (ffmpeg && typeof ffmpeg.ok === 'boolean') data.ffmpegOk = ffmpeg.ok;
      data.error = false;
      data.loaded = true;
    } catch (err) {
      if (mine !== seq) return;
      data.error = true;
      data.loaded = true;
      if (logger) logger.warn('LiveTV-Hub: Status nicht ladbar:', err && err.message ? err.message : err);
    }
    renderRecordings();
  }

  render();
  return { render, refresh, getModel: () => ({ epg: epgCardModel(getEpgInput ? getEpgInput() : {}), recordings: recordingsCardModel(data) }) };
}

module.exports = { createDashboardHub };
