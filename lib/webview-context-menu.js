// Natives Kontextmenü der Content-Webviews: reine Template-Funktion (deutsche Beschriftungen).

'use strict';

function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// params: Ausschnitt des `context-menu`-Ereignisses; actions: { copyLink(url), openLink(url) }.
function buildContextMenuTemplate(params = {}, actions = {}) {
  const groups = [];
  const flags = params.editFlags || {};
  const link = params.linkURL;
  const hasText = Boolean(params.selectionText && String(params.selectionText).trim());

  if (isHttpUrl(link)) {
    groups.push([
      { label: 'Link im Browser öffnen', click: () => actions.openLink?.(link) },
      { label: 'Link kopieren', click: () => actions.copyLink?.(link) },
    ]);
  }
  if (params.isEditable) {
    groups.push([
      { label: 'Ausschneiden', role: 'cut', enabled: flags.canCut !== false && hasText },
      { label: 'Kopieren', role: 'copy', enabled: flags.canCopy !== false && hasText },
      { label: 'Einfügen', role: 'paste', enabled: flags.canPaste !== false },
      { label: 'Alles auswählen', role: 'selectAll', enabled: flags.canSelectAll !== false },
    ]);
  } else if (hasText) {
    groups.push([{ label: 'Kopieren', role: 'copy' }]);
  }
  return groups.flatMap((group, i) => (i ? [{ type: 'separator' }, ...group] : group));
}

module.exports = { buildContextMenuTemplate };
