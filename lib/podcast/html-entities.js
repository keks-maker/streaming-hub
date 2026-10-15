'use strict';

// Entity-Auflösung für Feed-Texte und Shownotes: nur die XML-Standard-Entities, übliche HTML-Namen und numerische Zeichen.

// XML-Standard-Entities plus die in Shownotes üblichen HTML-Namen (nur Zeichen, nie Markup); alles andere entfällt
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', euro: '€', copy: '©', szlig: 'ß',
  bull: '•', middot: '·', trade: '™', reg: '®', deg: '°', times: '×', plusmn: '±', sect: '§', para: '¶', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ccedil: 'ç', ntilde: 'ñ', shy: '', zwj: '', zwnj: '',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
};

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{0,31});/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      try {
        return code === 0 ? '' : String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    const known = Object.hasOwn(NAMED_ENTITIES, entity) ? NAMED_ENTITIES[entity] : NAMED_ENTITIES[entity.toLowerCase()];
    return known === undefined ? '' : known; // unbekannte/eigene Entities nie auflösen
  });
}

module.exports = { decodeEntities, NAMED_ENTITIES };
