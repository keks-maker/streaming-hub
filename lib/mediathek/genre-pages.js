'use strict';

// Genre-/Rubrik-Seiten der drei Quellen: Kennung (id) prüfen und Seiten-Adresse bauen. Reine Funktionen, keine Netzzugriffe.
//   arte  id = Seitencode (DOR, RC-023814)                      -> api.arte.tv/api/emac/v3/de/web/pages/<code>/
//   ard   id = "<partner>/<editorial|compilation>/<slug>"       -> api.ardmediathek.de/page-gateway/pages/<partner>/<art>/<slug>
//   zdf   id = Dokument-ID einer Rubrik (z. B. "filme-104")     -> zdf-prod-futura.zdf.de/mediathekV2/document/<id>
// Nur diese Formen werden gebaut; alles andere ergibt null (nie eine frei vom Renderer gelieferte Adresse).

const { arteGenrePageUrl } = require('./parser-arte.js');

const ARD_ID = /^([a-z0-9]{1,30})\/(editorial|compilation)\/([A-Za-z0-9][A-Za-z0-9_.-]{0,119})$/;
const ZDF_ID = /^[A-Za-z0-9_-]{1,120}$/;
const ARD_WIDGET_PATH = '/page-gateway/widgets/';

function isValidGenreId(sourceId, id) {
  if (typeof id !== 'string') return false;
  if (sourceId === 'arte') return arteGenrePageUrl(id) !== null;
  if (sourceId === 'ard') return ARD_ID.test(id);
  if (sourceId === 'zdf') return ZDF_ID.test(id);
  return false;
}

/** Kennung einer ARD-Seitenadresse (.../pages/<partner>/<editorial|compilation>/<slug>); null bei anderen Adressen. */
function ardGenreId(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.hostname !== 'api.ardmediathek.de') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const at = parts.indexOf('pages');
    if (at !== 1 || parts[0] !== 'page-gateway' || parts.length !== 5) return null;
    const id = `${parts[2]}/${parts[3]}/${decodeURIComponent(parts[4])}`;
    return ARD_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Seiten-Adresse zu { sourceId, id }; null bei ungültiger Kennung. */
function genrePageUrl(genre) {
  if (!genre || !isValidGenreId(genre.sourceId, genre.id)) return null;
  if (genre.sourceId === 'arte') return arteGenrePageUrl(genre.id);
  if (genre.sourceId === 'ard') return `https://api.ardmediathek.de/page-gateway/pages/${genre.id}?embedded=true`;
  return `https://zdf-prod-futura.zdf.de/mediathekV2/document/${genre.id}`;
}

/** Nachlade-Adresse eines ARD-Widgets (page-gateway/widgets/...): nur dieser Host und Pfad. */
function isArdWidgetUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'api.ardmediathek.de' && url.pathname.startsWith(ARD_WIDGET_PATH) && !url.username && !url.password;
  } catch {
    return false;
  }
}

module.exports = { isValidGenreId, ardGenreId, genrePageUrl, isArdWidgetUrl };
