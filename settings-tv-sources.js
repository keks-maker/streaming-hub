// Einstellungen: LiveTV-Seiten "Quellen" und "EPG" (Issue #4, Etappe 2).
// Quellenverwaltung inline statt Modal. Persistenz laeuft ausschliesslich ueber die
// bestehenden IPC-Aufrufe (addTvSource / updateTvSource / removeTvSource); main.js
// merged Updates per Spread, favorites/sortOrder/channelOverrides bleiben erhalten,
// solange sie nicht mitgesendet werden.

const DEFAULT_COLOR = '#a78bfa';

// Dateipfad (lokal) oder URL? Gleiche Heuristik wie das bisherige TV-Modal.
function detectSourceType(url) {
  const value = String(url || '').trim();
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || /^[A-Z]:\\/i.test(value)
    ? 'file'
    : 'url';
}

// Neue Quelle aus Formularwerten; null bei fehlenden Pflichtfeldern.
function buildNewSource(form, { forceFile = false } = {}) {
  const name = String(form.name || '').trim();
  const url = String(form.url || '').trim();
  if (!name || !url) return null;
  const epgUrl = String(form.epgUrl || '').trim();
  return {
    name,
    url,
    type: forceFile ? 'file' : detectSourceType(url),
    color: form.color || DEFAULT_COLOR,
    epgUrl: epgUrl || null,
  };
}

// Nur geaenderte Felder (name/url/epgUrl/color). Niemals favorites, sortOrder oder
// channelOverrides senden: main.js uebernimmt diese aus der bestehenden Quelle.
// Leeres Ergebnis = nichts zu speichern; { error } bei ungueltiger Eingabe.
function buildSourceUpdates(original, form) {
  const updates = {};
  const name = String(form.name ?? original.name ?? '').trim();
  const url = String(form.url ?? original.url ?? '').trim();
  if (!name) return { error: 'Name darf nicht leer sein' };
  if (!url) return { error: 'URL bzw. Datei darf nicht leer sein' };
  if (name !== original.name) updates.name = name;
  if (url !== original.url) {
    updates.url = url;
    if (form.type !== undefined && form.type !== original.type) updates.type = form.type;
  }
  if (form.epgUrl !== undefined) {
    const epgUrl = String(form.epgUrl).trim() || null;
    if (epgUrl !== (original.epgUrl || null)) updates.epgUrl = epgUrl;
  }
  if (form.color !== undefined && form.color !== (original.color || DEFAULT_COLOR)) updates.color = form.color;
  return updates;
}

// Fehlertext aus einem IPC-Fehler: Electron-Präfix entfernen, rohe Node-Meldungen
// ("TypeError: Invalid URL") in verständliches Deutsch übersetzen.
function formatIpcError(e) {
  const raw = (e && e.message ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (?:(?:Type|Range|Syntax)?Error: )?/,
    '',
  );
  if (/^Invalid URL\b/i.test(raw)) {
    return 'Ungültige URL – bitte die vollständige Adresse inklusive https:// eingeben';
  }
  return raw;
}

function formatLoadedAt(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createTvSourcesView({ root, api, getSources, safeColor, onRefreshEpg, getEpgInfo }) {
  const sourcesHost = root.querySelector('#settingsTvSourceList');
  const addHost = root.querySelector('#settingsTvSourceAdd');
  const sourcesStatus = root.querySelector('#settingsTvSourcesStatus');
  const epgHost = root.querySelector('#settingsEpgSourceList');
  const epgStatus = root.querySelector('#settingsEpgStatus');
  const epgRefreshBtn = root.querySelector('#settingsEpgRefreshBtn');
  let editingId = null;

  function setStatus(message, isError = false) {
    if (!sourcesStatus) return;
    sourcesStatus.textContent = message || '';
    sourcesStatus.classList.toggle('error', Boolean(isError));
  }

  const errorMessage = formatIpcError;

  function field(labelText, control) {
    const wrap = el('label', 'settings-field');
    wrap.appendChild(el('span', 'settings-field-label', labelText));
    wrap.appendChild(control);
    return wrap;
  }

  function input(type, value, placeholder, extraClass = '') {
    const node = el('input', `modal-input ${extraClass}`.trim());
    node.type = type;
    node.value = value || '';
    node.defaultValue = node.value;
    if (placeholder) node.placeholder = placeholder;
    if (type === 'text' || type === 'url') {
      node.autocomplete = 'off';
      node.spellcheck = false;
    }
    return node;
  }

  // Gemeinsames Formular fuer Hinzufuegen und Bearbeiten.
  function buildForm({ source, submitLabel, onSubmit, onCancel }) {
    const form = el('form', 'settings-source-form');
    form.noValidate = true;
    const nameInput = input('text', source?.name, 'z.B. Deutsche Sender');
    nameInput.name = 'name';
    const urlInput = input('text', source?.url, 'https://example.com/playlist.m3u', 'tv-url-input');
    urlInput.name = 'url';
    const fileBtn = el('button', 'tv-file-btn', '📁');
    fileBtn.type = 'button';
    fileBtn.title = 'Lokale Datei auswählen';
    fileBtn.setAttribute('aria-label', 'Lokale M3U-Datei auswählen');
    let pickedFile = source?.type === 'file';
    urlInput.addEventListener('input', () => {
      pickedFile = false;
    });
    fileBtn.addEventListener('click', async () => {
      try {
        const filePath = await api.pickM3uFile();
        if (filePath) {
          urlInput.value = filePath;
          pickedFile = true;
        }
      } catch (e) {
        setStatus(errorMessage(e), true);
      }
    });
    const urlRow = el('div', 'tv-url-row');
    urlRow.appendChild(urlInput);
    urlRow.appendChild(fileBtn);
    const urlField = el('div', 'settings-field');
    urlField.appendChild(el('span', 'settings-field-label', 'M3U-URL oder Datei'));
    urlField.appendChild(urlRow);
    const epgInput = input('url', source?.epgUrl, 'https://example.com/epg.xml (optional)');
    epgInput.name = 'epgUrl';
    const colorInput = input('color', safeColor(source?.color, DEFAULT_COLOR), '', 'modal-color');
    colorInput.name = 'color';
    colorInput.className = 'modal-color';

    form.appendChild(field('Quellen-Name', nameInput));
    form.appendChild(urlField);
    form.appendChild(field('EPG-URL (optional)', epgInput));
    form.appendChild(field('Akzentfarbe', colorInput));
    const actions = el('div', 'settings-tv-actions');
    const submit = el('button', 'modal-btn modal-btn-save', submitLabel);
    submit.type = 'submit';
    actions.appendChild(submit);
    if (onCancel) {
      const cancel = el('button', 'settings-action-btn', 'Abbrechen');
      cancel.type = 'button';
      cancel.addEventListener('click', onCancel);
      actions.appendChild(cancel);
    }
    form.appendChild(actions);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await onSubmit(
          { name: nameInput.value, url: urlInput.value, epgUrl: epgInput.value, color: colorInput.value },
          { forceFile: pickedFile },
        );
      } catch (err) {
        setStatus(errorMessage(err), true);
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function renderRow(src) {
    const row = el('div', 'settings-source-row');
    row.dataset.sourceId = src.id;
    if (editingId === src.id) {
      row.classList.add('editing');
      row.appendChild(
        buildForm({
          source: src,
          submitLabel: 'Speichern',
          onCancel: () => {
            editingId = null;
            setStatus('');
            render();
          },
          onSubmit: async (form, opts) => {
            const type = opts.forceFile ? 'file' : detectSourceType(form.url);
            const updates = buildSourceUpdates(src, { ...form, type });
            if (updates.error) {
              setStatus(updates.error, true);
              return;
            }
            if (Object.keys(updates).length) await api.updateTvSource(src.id, updates);
            editingId = null;
            setStatus('✓ Quelle gespeichert');
            render();
          },
        }),
      );
      return row;
    }
    const dot = el('span', 'settings-source-color');
    dot.style.background = safeColor(src.color, DEFAULT_COLOR);
    dot.setAttribute('aria-hidden', 'true');
    const info = el('div', 'settings-source-info');
    const head = el('div', 'settings-source-name', src.name);
    head.appendChild(el('span', 'settings-source-type', src.type === 'file' ? 'Datei' : 'URL'));
    info.appendChild(head);
    info.appendChild(el('div', 'settings-source-meta', src.url));
    info.appendChild(el('div', 'settings-source-meta', src.epgUrl ? `EPG: ${src.epgUrl}` : 'Keine EPG-URL'));
    const edit = el('button', 'settings-action-btn', 'Bearbeiten');
    edit.type = 'button';
    edit.dataset.action = 'edit';
    edit.addEventListener('click', () => {
      editingId = src.id;
      setStatus('');
      render();
    });
    const remove = el('button', 'settings-action-btn settings-danger-btn', 'Entfernen');
    remove.type = 'button';
    remove.dataset.action = 'remove';
    remove.addEventListener('click', async () => {
      if (!confirm(`Quelle "${src.name}" entfernen?\nFavoriten und Sender-Anpassungen dieser Quelle gehen verloren.`)) return;
      try {
        await api.removeTvSource(src.id);
        setStatus('✓ Quelle entfernt');
      } catch (e) {
        setStatus(errorMessage(e), true);
      }
    });
    const actions = el('div', 'settings-source-actions');
    actions.appendChild(edit);
    actions.appendChild(remove);
    row.appendChild(dot);
    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }

  function renderSourceList(sources) {
    sourcesHost.innerHTML = '';
    if (!sources.length) {
      sourcesHost.appendChild(el('div', 'service-list-empty', 'Keine TV-Quellen konfiguriert.'));
      return;
    }
    sources.forEach(src => sourcesHost.appendChild(renderRow(src)));
  }

  function renderEpgList(sources) {
    epgHost.innerHTML = '';
    if (!sources.length) {
      epgHost.appendChild(el('div', 'service-list-empty', 'Keine TV-Quellen konfiguriert.'));
      return;
    }
    sources.forEach(src => {
      const row = el('form', 'settings-epg-row');
      row.noValidate = true;
      row.dataset.sourceId = src.id;
      const label = el('span', 'settings-row-label', src.name);
      const epgInput = input('url', src.epgUrl, 'https://example.com/epg.xml');
      epgInput.setAttribute('aria-label', `EPG-URL für ${src.name}`);
      const save = el('button', 'settings-action-btn', 'Speichern');
      save.type = 'submit';
      row.appendChild(label);
      row.appendChild(epgInput);
      row.appendChild(save);
      row.addEventListener('submit', async e => {
        e.preventDefault();
        const updates = buildSourceUpdates(src, { name: src.name, url: src.url, epgUrl: epgInput.value });
        if (!Object.keys(updates).length) {
          setEpgStatus('Keine Änderung');
          return;
        }
        save.disabled = true;
        try {
          await api.updateTvSource(src.id, updates);
          setEpgStatus('✓ EPG-URL gespeichert');
        } catch (err) {
          setEpgStatus(errorMessage(err), true);
        } finally {
          save.disabled = false;
        }
      });
      epgHost.appendChild(row);
    });
  }

  let epgMessage = '';
  function setEpgStatus(message, isError = false) {
    epgMessage = message || '';
    epgStatus.classList.toggle('error', Boolean(isError));
    updateEpgInfo();
  }

  function updateEpgInfo() {
    if (!epgStatus) return;
    const info = getEpgInfo ? getEpgInfo() : { text: '', loadedAt: null, busy: false };
    const parts = [epgMessage, info.text];
    const loaded = formatLoadedAt(info.loadedAt);
    if (loaded) parts.push(`Letzter Abruf: ${loaded}`);
    epgStatus.textContent = parts.filter(Boolean).join(' · ');
    if (epgRefreshBtn) epgRefreshBtn.disabled = Boolean(info.busy);
  }

  function render() {
    const sources = getSources();
    if (editingId && !sources.some(s => s.id === editingId)) editingId = null;
    renderSourceList(sources);
    renderEpgList(sources);
    updateEpgInfo();
  }

  addHost.appendChild(
    buildForm({
      submitLabel: 'Hinzufügen',
      onSubmit: async (values, opts) => {
        const source = buildNewSource(values, opts);
        if (!source) {
          setStatus('Name und URL bzw. Datei sind erforderlich', true);
          return;
        }
        await api.addTvSource(source);
        addHost.querySelector('form').reset();
        setStatus('✓ Quelle hinzugefügt');
      },
    }),
  );

  if (epgRefreshBtn) {
    epgRefreshBtn.addEventListener('click', async () => {
      setEpgStatus('');
      try {
        await onRefreshEpg();
      } finally {
        updateEpgInfo();
      }
    });
  }

  return { render, updateEpgInfo };
}

module.exports = { detectSourceType, buildNewSource, buildSourceUpdates, formatIpcError, formatLoadedAt, createTvSourcesView };
