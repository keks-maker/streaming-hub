// Verdrahtung der Gast-webContents der Content-Webviews (persist:streaming, auch PiP): externe Links und Kontextmenü.
// Andere Partitionen (z. B. persist:tv) bleiben unberührt.

'use strict';

const { classifyWindowOpen, classifyNavigation } = require('./webview-links.js');
const { buildContextMenuTemplate } = require('./webview-context-menu.js');

// Höchstens ein Öffnen im Browser pro Gast in diesem Zeitraum (gegen Popup-Serien ohne Nutzergeste).
const EXTERNAL_THROTTLE_MS = 1000;

function attachWebviewGuest(contents, { streamingSession, shell, Menu, clipboard, logger, now = Date.now, onYoutubeAction = null, isYoutubeMiniEnabled = () => true }) {
  if (!contents || contents.getType?.() !== 'webview' || contents.session !== streamingSession) return false;
  const openExternal = url => shell.openExternal(url).catch(e => logger?.warn?.('Link konnte nicht geöffnet werden:', e.message));
  let lastPopupExternal = -Infinity;
  const pageUrl = () => {
    try {
      return contents.getURL();
    } catch (_) {
      return '';
    }
  };

  contents.setWindowOpenHandler(({ url }) => {
    const result = classifyWindowOpen({ url, pageUrl: pageUrl() });
    if (result.action === 'external') {
      const t = now();
      if (t - lastPopupExternal >= EXTERNAL_THROTTLE_MS) {
        lastPopupExternal = t;
        openExternal(result.url);
      }
    }
    else if (result.action === 'internal') contents.loadURL(result.url).catch(() => {});
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    const result = classifyNavigation({ url });
    if (result.action !== 'external') return;
    event.preventDefault();
    openExternal(result.url);
  });

  contents.on('context-menu', (_event, params) => {
    const youtube =
      typeof onYoutubeAction === 'function' && isYoutubeMiniEnabled(contents)
        ? {
            youtubeNext: url => onYoutubeAction(contents, { action: 'next', url, title: params.linkText || '' }),
            youtubeAdd: url => onYoutubeAction(contents, { action: 'add', url, title: params.linkText || '' }),
          }
        : {};
    const template = buildContextMenuTemplate(params, {
      openLink: openExternal,
      copyLink: url => clipboard.writeText(url),
      ...youtube,
    });
    if (template.length) Menu.buildFromTemplate(template).popup();
  });
  return true;
}

module.exports = { attachWebviewGuest };
