'use strict';

// Einstellungen → Radio → Eigene Sender (R3): Liste, Hinzufügen, Bearbeiten, Löschen. Name und Stream-URL sind
// Pflicht, Webseite, Logo-URL und Genre optional. Aus der Webseite (oder dem ICY-Header des Streams) schlägt
// „Logo suchen“ ein Logo vor (radio:find-logo), das nur in ein leeres Logo-Feld eingetragen wird. „Stream prüfen“ (radio:probe) zeigt Erreichbarkeit und Format vor dem
// Speichern. Validierungsfehler des Main werden als Klartext angezeigt. Logik: settings-radio-custom-model.js.

const model = require('./settings-radio-custom-model.js');
const { el, appendStationLogo, statusLine, setStatus, labelledField, textInput, button, focusNode, findAll, childList, formatIpcError } = require('./settings-radio-dom.js');
const { radioHomepageUrlError } = require('./lib/input-validation.js');

const EMPTY_FORM = Object.freeze({ name: '', streamUrl: '', logo: '', genre: '', homepage: '' });

function createRadioCustomView(root, { radio, logger = null } = {}) {
  const doc = root.ownerDocument || document;
  const state = {
    sources: [],
    loaded: false,
    form: null, // { id|null, values, errors, probe: { busy, ok, text }|null }
    confirmRemove: null, // Sender-ID
    restoreFocus: null,
  };

  const addBtn = button(doc, 'modal-btn modal-btn-save', 'Sender hinzufügen', 'add');
  addBtn.id = 'settingsRadioCustomAdd';
  const listEl = el(doc, 'div', 'settings-chan-list');
  listEl.id = 'settingsRadioCustomList';
  listEl.setAttribute('role', 'list');
  const formHost = el(doc, 'div', 'settings-radio-custom-form-host');
  const statusEl = statusLine(doc, 'settingsRadioCustomStatus');
  const genreList = el(doc, 'datalist');
  genreList.id = 'settingsRadioGenres';
  root.textContent = '';
  root.append(addBtn, listEl, formHost, statusEl, genreList);

  const fail = error => {
    setStatus(statusEl, formatIpcError(error), true);
    render();
  };

  function setSources(next) {
    if (!Array.isArray(next)) return;
    // Das Broadcast-Ereignis nach dem eigenen Speichern liefert denselben Stand: nicht neu zeichnen, sonst geht der Fokus verloren
    const serialized = JSON.stringify(next);
    if (state.loaded && serialized === state.serialized) return;
    state.serialized = serialized;
    state.sources = next;
    state.loaded = true;
    render();
  }

  async function refresh() {
    try {
      setSources(await radio.getSources());
    } catch (error) {
      if (logger) logger.warn('Radio-Einstellungen: eigene Sender konnten nicht geladen werden', error && error.message);
      setStatus(statusEl, 'Eigene Sender konnten nicht geladen werden', true);
    }
  }

  // ── Formular ──
  function openForm(station) {
    state.confirmRemove = null;
    state.form = {
      id: station ? station.id : null,
      current: station ? { name: station.name, streamUrl: station.streamUrl, logo: station.logo, genre: station.genre, homepage: station.homepage } : { ...EMPTY_FORM },
      values: station ? { name: station.name, streamUrl: station.streamUrl, logo: station.logo, genre: station.genre, homepage: station.homepage } : { ...EMPTY_FORM },
      controls: {},
      logoSearch: null, // { busy, ok, text }
      autoLogo: '', // zuletzt automatisch eingetragenes Logo (darf von einer neuen Suche ersetzt werden)
      errors: {},
      probe: null,
      focusField: 'name',
    };
    setStatus(statusEl, '');
    render();
  }

  function closeForm(focusKey) {
    state.form = null;
    state.restoreFocus = focusKey ? { key: focusKey, action: 'edit' } : { key: null, action: 'add' };
    render();
  }

  // Anzeige des Prüfergebnisses ohne Neuaufbau des Formulars (Eingabefokus und Cursor bleiben erhalten)
  function updateProbeUi(form) {
    const ui = form.ui;
    if (!ui) return;
    const probe = form.probe;
    ui.button.disabled = Boolean(probe && probe.busy);
    ui.text.textContent = probe ? probe.text : '';
    ui.text.className = `settings-radio-probe${probe && !probe.busy ? (probe.ok ? ' ok' : ' error') : ''}`;
  }

  async function runProbe() {
    const form = state.form;
    if (!form) return;
    const { errors, value } = model.validateStationForm(form.values);
    if (errors.streamUrl) {
      form.errors = { ...form.errors, streamUrl: errors.streamUrl };
      form.probe = null;
      form.focusField = 'streamUrl';
      render();
      return;
    }
    form.probe = { busy: true, ok: false, text: 'Prüfe Stream …' };
    form.probeUrl = value.streamUrl;
    updateProbeUi(form);
    let result;
    try {
      result = await radio.probe(value.streamUrl);
    } catch (error) {
      result = { ok: false, error: formatIpcError(error) };
    }
    // Ergebnis gilt nur für die geprüfte URL; wurde sie inzwischen geändert oder das Formular geschlossen, verfällt es
    if (state.form !== form || form.probeUrl !== String(form.values.streamUrl).trim()) return;
    form.probe = { busy: false, ...model.probeResultText(result) };
    updateProbeUi(form);
    focusNode(form.ui.button);
    // Webseite aus icy-url nur in ein leeres Feld übernehmen, danach Logo vorschlagen
    const prefilled = model.prefillHomepage(form.values.homepage, result);
    if (prefilled !== form.values.homepage) setFieldValue(form, 'homepage', prefilled);
    if (result && result.ok) await runLogoSearch({ auto: true });
  }

  function setFieldValue(form, field, value) {
    form.values[field] = value;
    if (form.errors[field]) delete form.errors[field];
    const control = form.controls[field];
    if (control) control.value = value;
    if (field === 'logo') updateLogoPreview(form);
  }

  // Vorschau neben dem Logo-Feld; Fehler oder leer: Platzhalter mit Anfangsbuchstaben
  function updateLogoPreview(form) {
    const ui = form.ui;
    if (!ui || !ui.preview) return;
    ui.preview.textContent = '';
    appendStationLogo(doc, ui.preview, { name: form.values.name, logo: String(form.values.logo || '').trim() });
  }

  function updateLogoUi(form) {
    const ui = form.ui;
    if (!ui || !ui.logoStatus) return;
    const search = form.logoSearch;
    ui.logoButton.disabled = Boolean(search && search.busy);
    ui.logoStatus.textContent = search ? search.text : '';
    ui.logoStatus.className = `settings-radio-probe${search && !search.busy ? (search.ok ? ' ok' : ' error') : ''}`;
  }

  /**
   * Logo-Vorschlag aus der Webseite. auto: nach „Stream prüfen“ (still, wenn schon ein Logo eingetragen ist);
   * manuell („Logo suchen“) meldet ein gefülltes Logo-Feld. Das Formular bleibt währenddessen bedienbar.
   */
  async function runLogoSearch({ auto = false } = {}) {
    const form = state.form;
    if (!form || (form.logoSearch && form.logoSearch.busy)) return;
    const homepage = String(form.values.homepage || '').trim();
    if (!model.canFillLogo(form.values.logo, form.autoLogo)) {
      if (!auto) {
        form.logoSearch = { busy: false, ok: false, text: 'Das Logo-Feld ist bereits ausgefüllt – zum Suchen zuerst leeren' };
        updateLogoUi(form);
      }
      return;
    }
    if (!homepage) {
      form.logoSearch = { busy: false, ok: false, text: model.NO_HOMEPAGE_TEXT };
      updateLogoUi(form);
      return;
    }
    const homepageError = radioHomepageUrlError(homepage);
    if (homepageError) {
      form.logoSearch = { busy: false, ok: false, text: homepageError };
      updateLogoUi(form);
      return;
    }
    form.logoSearch = { busy: true, ok: false, text: 'Suche Logo …' };
    updateLogoUi(form);
    let result;
    try {
      result = await radio.findLogo({ homepage });
    } catch (error) {
      result = { ok: false, error: formatIpcError(error) };
    }
    // Ergebnis gilt nur für diese Webseite und dieses Formular
    if (state.form !== form || String(form.values.homepage || '').trim() !== homepage) return;
    const text = model.logoResultText(result);
    form.logoSearch = { busy: false, ok: text.ok && text.found, text: text.text };
    if (result && result.ok && result.logo && model.canFillLogo(form.values.logo, form.autoLogo)) {
      form.autoLogo = result.logo;
      setFieldValue(form, 'logo', result.logo);
    }
    updateLogoUi(form);
  }

  async function saveForm() {
    const form = state.form;
    if (!form) return;
    const { errors, value } = model.validateStationForm(form.values);
    form.errors = errors;
    form.mainError = '';
    if (Object.keys(errors).length) {
      setStatus(statusEl, 'Bitte die markierten Felder korrigieren', true);
      form.focusField = Object.keys(errors)[0];
      render();
      return;
    }
    try {
      if (form.id) setSources(await radio.updateCustom(form.id, model.toUpdatePatch(value, form.current)));
      else await radio.addCustom(model.toAddInput(value));
      const verb = form.id ? 'gespeichert' : 'hinzugefügt';
      state.form = null;
      await refresh();
      state.restoreFocus = { key: null, action: 'add' };
      setStatus(statusEl, `✓ Sender ${verb}`);
      render();
    } catch (error) {
      // Fehlertext des Main (z. B. ungültige URL) steht am Formular, nicht nur im Status
      form.errors = {};
      form.mainError = formatIpcError(error);
      render();
    }
  }

  async function removeStation(id) {
    try {
      setSources(await radio.removeCustom(id));
      state.confirmRemove = null;
      state.restoreFocus = { key: null, action: 'add' };
      setStatus(statusEl, '✓ Sender gelöscht');
      render();
    } catch (error) {
      fail(error);
    }
  }

  function buildForm() {
    const form = state.form;
    const wrap = el(doc, 'form', 'settings-source-form settings-radio-custom-form');
    wrap.noValidate = true;
    wrap.setAttribute('aria-label', form.id ? 'Sender bearbeiten' : 'Sender hinzufügen');
    wrap.appendChild(el(doc, 'h4', 'settings-card-title', form.id ? 'Sender bearbeiten' : 'Sender hinzufügen'));
    const input = (field, label, placeholder, extra = {}) => {
      const control = textInput(doc, { field, value: form.values[field], placeholder });
      form.controls[field] = control;
      if (extra.list) control.setAttribute('list', extra.list);
      control.addEventListener('input', () => {
        form.values[field] = control.value;
        if (field === 'name') updateLogoPreview(form);
        // Feldfehler ist mit der Eingabe überholt (auch im Zustand, sonst käme er beim nächsten Rendern zurück)
        if (form.errors[field]) delete form.errors[field];
        if (statusEl.classList.contains('error')) setStatus(statusEl, '');
        if (field === 'streamUrl' && form.probe) {
          form.probe = null; // Ergebnis gilt nur für die geprüfte URL
          updateProbeUi(form);
        }
      });
      const fieldNode = labelledField(doc, label, control, { error: form.errors[field], hint: extra.hint, idBase: `settingsRadioCustom-${field}` });
      (extra.parent || wrap).appendChild(fieldNode);
      return control;
    };
    input('name', 'Name (Pflicht)', 'z. B. Mein Sender');
    input('streamUrl', 'Stream-URL (Pflicht)', 'https://… (Stream, .pls, .m3u oder HLS)');

    const probeRow = el(doc, 'div', 'settings-chan-urlrow');
    const probeBtn = button(doc, 'settings-action-btn', 'Stream prüfen', 'probe');
    probeBtn.addEventListener('click', runProbe);
    const probeText = el(doc, 'div', 'settings-radio-probe');
    probeText.id = 'settingsRadioProbeResult';
    probeText.setAttribute('role', 'status');
    probeText.setAttribute('aria-live', 'polite');
    probeRow.append(probeBtn, probeText);
    wrap.appendChild(probeRow);
    form.ui = { button: probeBtn, text: probeText };
    updateProbeUi(form);

    input('homepage', 'Webseite (optional)', 'https://… (für die Logo-Suche)');

    const logoRow = el(doc, 'div', 'settings-radio-logorow');
    const logoControl = input('logo', 'Logo-URL (optional)', 'https://…', { parent: logoRow });
    logoControl.addEventListener('change', () => updateLogoPreview(form));
    const logoBtn = button(doc, 'settings-action-btn', 'Logo suchen', 'find-logo');
    logoBtn.addEventListener('click', () => runLogoSearch({ auto: false }));
    logoRow.appendChild(logoBtn);
    wrap.appendChild(logoRow);
    const preview = el(doc, 'div', 'settings-radio-logo-preview');
    const logoStatus = el(doc, 'div', 'settings-radio-probe');
    logoStatus.id = 'settingsRadioLogoStatus';
    logoStatus.setAttribute('role', 'status');
    logoStatus.setAttribute('aria-live', 'polite');
    const logoInfo = el(doc, 'div', 'settings-radio-logoinfo');
    logoInfo.append(preview, logoStatus);
    wrap.appendChild(logoInfo);
    form.ui.preview = preview;
    form.ui.logoButton = logoBtn;
    form.ui.logoStatus = logoStatus;
    updateLogoPreview(form);
    updateLogoUi(form);
    input('genre', 'Genre (optional)', 'z. B. Rock', { list: genreList.id });

    if (form.mainError) {
      const err = el(doc, 'div', 'settings-chan-error', form.mainError);
      err.setAttribute('role', 'alert');
      wrap.appendChild(err);
    }
    const actions = el(doc, 'div', 'settings-tv-actions');
    const save = el(doc, 'button', 'modal-btn modal-btn-save', form.id ? 'Speichern' : 'Hinzufügen');
    save.type = 'submit';
    save.dataset.action = 'save';
    const cancel = button(doc, 'settings-action-btn', 'Abbrechen', 'cancel');
    cancel.addEventListener('click', () => closeForm(form.id));
    actions.append(save, cancel);
    wrap.appendChild(actions);
    wrap.addEventListener('submit', event => {
      event.preventDefault();
      saveForm();
    });
    wrap.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (JSON.stringify(form.values) === JSON.stringify(form.current)) closeForm(form.id);
      else setStatus(statusEl, 'Ungespeicherte Änderungen – speichern oder mit „Abbrechen“ verwerfen', true);
    });
    return wrap;
  }

  // ── Liste ──
  function buildRow(station) {
    const row = el(doc, 'div', 'settings-chan-row');
    row.setAttribute('role', 'listitem');
    row.dataset.key = station.id;
    const head = el(doc, 'div', 'settings-chan-head');
    appendStationLogo(doc, head, station);
    const info = el(doc, 'div', 'settings-chan-info');
    info.appendChild(el(doc, 'div', 'settings-chan-name', station.name));
    const meta = el(doc, 'div', 'settings-chan-meta');
    if (station.genre) meta.appendChild(el(doc, 'span', '', station.genre));
    const url = el(doc, 'span', 'settings-chan-tvgid', station.streamUrl);
    url.title = station.streamUrl;
    meta.appendChild(url);
    info.appendChild(meta);
    head.appendChild(info);

    const actions = el(doc, 'div', 'settings-chan-actions');
    const edit = button(doc, 'settings-action-btn', 'Bearbeiten', 'edit');
    edit.setAttribute('aria-label', `${station.name}: bearbeiten`);
    edit.addEventListener('click', () => openForm(station));
    actions.appendChild(edit);
    if (state.confirmRemove === station.id) {
      const sure = button(doc, 'settings-action-btn settings-danger-btn', 'Wirklich löschen', 'confirm-remove');
      sure.setAttribute('aria-label', `${station.name}: endgültig löschen`);
      sure.addEventListener('click', () => removeStation(station.id));
      const no = button(doc, 'settings-action-btn', 'Behalten', 'cancel-remove');
      no.addEventListener('click', () => {
        state.confirmRemove = null;
        state.restoreFocus = { key: station.id, action: 'remove' };
        render();
      });
      actions.append(sure, no);
    } else {
      const remove = button(doc, 'settings-action-btn settings-danger-btn', 'Löschen', 'remove');
      remove.setAttribute('aria-label', `${station.name}: löschen`);
      remove.addEventListener('click', () => {
        state.confirmRemove = station.id;
        state.restoreFocus = { key: station.id, action: 'confirm-remove' };
        render();
      });
      actions.appendChild(remove);
    }
    head.appendChild(actions);
    row.appendChild(head);
    return row;
  }

  function restoreFocus() {
    if (state.form && state.form.focusField) {
      const field = state.form.focusField;
      state.form.focusField = null;
      focusNode(findAll(formHost, n => n.dataset && n.dataset.field === field)[0]);
      return;
    }
    if (!state.restoreFocus) return;
    const { key, action } = state.restoreFocus;
    state.restoreFocus = null;
    const scope = key ? childList(listEl).find(r => r.dataset.key === key) : root;
    const target = scope && findAll(scope, n => n.dataset && n.dataset.action === action && !n.disabled)[0];
    focusNode(target || (key ? null : addBtn));
  }

  function render() {
    if (!state.loaded) return;
    const stations = model.customStations(state.sources);
    listEl.textContent = '';
    if (!stations.length) listEl.appendChild(el(doc, 'div', 'service-list-empty', 'Noch keine eigenen Sender. Füge einen Stream mit „Sender hinzufügen“ hinzu.'));
    stations.forEach(station => listEl.appendChild(buildRow(station)));
    genreList.textContent = '';
    model.genreSuggestions(state.sources).forEach(genre => {
      const option = el(doc, 'option');
      option.value = genre;
      genreList.appendChild(option);
    });
    formHost.textContent = '';
    addBtn.hidden = Boolean(state.form);
    if (state.form) formHost.appendChild(buildForm());
    restoreFocus();
  }

  addBtn.addEventListener('click', () => openForm(null));

  const unsubscribers = [];
  if (radio.onSourcesChanged) unsubscribers.push(radio.onSourcesChanged(setSources));

  return {
    refresh,
    render,
    /** Öffnet das Bearbeiten-Formular eines eigenen Senders (Sprung von der Senderliste). */
    edit(id) {
      const station = model.customStations(state.sources).find(s => s.id === id);
      if (station) openForm(station);
    },
    getState: () => state,
    dispose: () => unsubscribers.forEach(off => typeof off === 'function' && off()),
  };
}

module.exports = { createRadioCustomView };
