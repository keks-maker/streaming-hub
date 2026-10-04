// XMLTV-Streaming-Parser für den EPG-Cache im Main-Prozess (Etappe 1; Konzept §3.2)
//
// Warum nicht typed-core `parseXMLTV`? Der Renderer-Parser braucht den GANZEN
// Text als String (50 MB+) und matcht per Regex über das Gesamtdokument. Dieser
// Parser bekommt Text-Chunks (write) und hält nur das Fragment des gerade
// offenen <programme>-Elements im Speicher. Es werden nur Sendungen im
// Zeitfenster geliefert — der Rest wird nie aufgebaut.
//
// Zeit: XMLTV-Zeiten tragen ihren Offset ("20261025013000 +0200"). Die
// Umrechnung nach UTC-Millisekunden läuft über typed-core `parseEpgTime`
// (explizite Offsets, unabhängig von der Systemzeitzone → Sommerzeitwechsel
// ist korrekt, solange der Offset in der Quelle stimmt). Ohne Offset gilt UTC
// (XMLTV-Spezifikation).
//
// Texte: Entities und CDATA werden hier einmalig dekodiert (Einzeldurchlauf,
// kein Doppel-Decode wie bei „&amp;lt;“). Die Texte sind FREMDER INHALT und
// dürfen in der UI nur als Text (textContent), niemals per innerHTML
// gerendert werden.

'use strict';

const { parseEpgTime } = require('@streaming-hub/typed-core');

const MAX_TITLE_LENGTH = 300;
const MAX_DESC_LENGTH = 2000;
// Etappe 3.2 (EPG-Konzept B1/EPG-E7): zusätzliche Felder. Überlänge wird gekürzt, nie abgelehnt
// (Ausnahme icon: eine gekürzte URL wäre kaputt → zu lange URLs bleiben leer).
const MAX_CATEGORIES = 3;
const MAX_CATEGORY_LENGTH = 40;
const MAX_ICON_LENGTH = 512;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const MAX_EPISODE_LENGTH = 20;
const MAX_DIRECTORS = 2;
const MAX_ACTORS = 8;
const MAX_PRESENTERS = 2;
const MAX_PERSON_LENGTH = 80;
const MAX_SUBTITLE_LENGTH = 200;
const MAX_RATING_LENGTH = 30;
// Schutz vor bösartigen Einträgen: höchstens so viele Elemente werden je <programme> betrachtet
// (riesige credits-Listen, tausende unabgeschlossene Tags) — der Rest wird ignoriert.
const MAX_BODY_ELEMENTS = 2000;
// Ein einzelnes <programme>-Element ist klein; wächst das offene Fragment über
// diese Grenze, ist das Dokument defekt/bösartig → Element verwerfen.
const MAX_OPEN_ELEMENT_CHARS = 512 * 1024;

/**
 * Kopie als eigenständiger String. V8 liefert Teilstrings ab 13 Zeichen als „sliced strings“, die den
 * gesamten Eltern-String (hier: den Lese-Chunk) am Leben halten — gespeicherte Felder würden so die
 * ganze Quelldatei im Speicher halten. Für alles, was der Aufrufer behält, wird deshalb kopiert.
 */
function detach(value) {
  return value.length < 13 ? value : Buffer.from(value, 'utf8').toString('utf8');
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Dekodiert XML-Entities in einem Durchlauf (kein Doppel-Decode).
 */
function decodeXmlEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      try {
        return String.fromCodePoint(code);
      } catch (_) {
        return '';
      }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}

// (\s\s: Whitespace-Folge; [^\S ]: jedes Whitespace außer dem einfachen Leerzeichen, z. B. NBSP, Tab, Zeilenumbruch)
const NEEDS_TEXT_WORK = /[<&]|\s\s|[^\S ]/;

/**
 * Elementtext → Klartext: CDATA-Abschnitte unverändert, Rest entity-dekodiert,
 * eingebettete Tags entfernt, Whitespace normalisiert.
 */
function textOf(raw) {
  // Schnellpfad (häufig: Kategorien, Namen): nichts zu dekodieren/entfernen/zusammenzuziehen
  if (!NEEDS_TEXT_WORK.test(raw)) return raw.trim();
  let out = '';
  let last = 0;
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let m;
  while ((m = cdata.exec(raw)) !== null) {
    out += decodeXmlEntities(raw.slice(last, m.index).replace(/<[^>]*>/g, ''));
    out += m[1];
    last = m.index + m[0].length;
  }
  out += decodeXmlEntities(raw.slice(last).replace(/<[^>]*>/g, ''));
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * XMLTV-Zeitstring → UTC-ms oder NaN. Akzeptiert YYYYMMDD[HH[MM[SS]]] [±HHMM|Z].
 */
function parseXmltvTime(value) {
  if (typeof value !== 'string') return NaN;
  const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*(Z|[+-]\d{4})?\s*$/.exec(value);
  if (!m) return NaN;
  const tz = !m[7] || m[7] === 'Z' ? '+0000' : m[7];
  const normalized = `${m[1]}${m[2]}${m[3]}${m[4] || '00'}${m[5] || '00'}${m[6] || '00'} ${tz}`;
  const ms = parseEpgTime(normalized).getTime();
  // parseEpgTime liefert bei Fehlern Date(0); 1970-01-01 selbst ist kein gültiger EPG-Wert
  return ms === 0 ? NaN : ms;
}

function readAttributes(startTag) {
  const attrs = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(startTag)) !== null) {
    attrs[m[1]] = decodeXmlEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

const TITLE_RE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/;
const DESC_RE = /<desc(?:\s[^>]*)?>([\s\S]*?)<\/desc\s*>/;

function firstElementText(body, re) {
  const m = re.exec(body);
  return m ? textOf(m[1]) : '';
}

/**
 * Index des Endes eines Start-Tags ('>' außerhalb von Anführungszeichen),
 * ab `from`; -1, wenn noch nicht vollständig im Puffer.
 */
function findTagEnd(buf, from) {
  let quote = null;
  for (let i = from; i < buf.length; i += 1) {
    const ch = buf[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

const FIELD_TAGS = new Set(['category', 'icon', 'date', 'episode-num', 'director', 'actor', 'presenter', 'sub-title', 'rating']);
// Elemente, deren Inhalt der Feld-Scan überspringt (Inhalt kann CDATA/Fremdtext sein)
const SKIP_CONTENT_TAGS = new Set(['title', 'desc']);

const ATTR_RES = {
  src: /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)')/,
  system: /(?:^|\s)system\s*=\s*(?:"([^"]*)"|'([^']*)')/,
};

function attrOf(attrText, name) {
  const m = ATTR_RES[name].exec(attrText);
  return m ? decodeXmlEntities(m[1] !== undefined ? m[1] : m[2]) : '';
}

const TAG_NAME_RE = /<([A-Za-z][\w:.-]*)/y;

function parseIconUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || url.length > MAX_ICON_LENGTH) return '';
  // eslint-disable-next-line no-control-regex -- Steuerzeichen in URLs sind hier genau das Ziel
  if (!/^https?:\/\/[^\s\u0000-\u001f\u007f]+$/i.test(url)) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : '';
  } catch (_) {
    return '';
  }
}

function parseYear(text) {
  const m = /^\s*(\d{4})/.exec(text);
  if (!m) return 0;
  const year = Number(m[1]);
  return year >= MIN_YEAR && year <= MAX_YEAR ? year : 0;
}

/**
 * xmltv_ns ("Staffel.Folge.Teil", nullbasiert, je optional mit "/Gesamt") → "S2 E3".
 * Leer, wenn weder Staffel noch Folge vorhanden sind.
 */
function episodeFromXmltvNs(text) {
  const parts = text.split('.');
  const num = part => {
    const m = /^\s*(\d{1,4})\s*(?:\/\s*\d+\s*)?$/.exec(part || '');
    return m ? Number(m[1]) + 1 : null;
  };
  const season = num(parts[0]);
  const episode = num(parts[1]);
  return [season !== null ? `S${season}` : '', episode !== null ? `E${episode}` : ''].filter(Boolean).join(' ');
}

/** Erster Kindinhalt <name>…</name> in `content` oder null (indexOf-basiert, linear). */
function firstChildText(content, name) {
  const open = content.indexOf(`<${name}`);
  if (open === -1) return null;
  const tagEnd = content.indexOf('>', open);
  if (tagEnd === -1) return null;
  const close = content.indexOf(`</${name}`, tagEnd + 1);
  return close === -1 ? null : content.slice(tagEnd + 1, close);
}

function emptyFields() {
  return {
    subtitle: '',
    categories: [],
    icon: '',
    year: 0,
    episode: '',
    credits: { director: [], actor: [], presenter: [] },
    rating: '',
  };
}

function pushLimited(list, value, max) {
  if (list.length >= max) return;
  const text = value.slice(0, MAX_PERSON_LENGTH);
  if (text && !list.includes(text)) list.push(text);
}

/**
 * Liest die Zusatzfelder aus dem <programme>-Inhalt. Eigener, linearer Scan (kein
 * Regex über das Gesamtfragment): fehlende Schlusstags werden je Name nur einmal
 * gesucht, die Zahl betrachteter Elemente ist begrenzt (MAX_BODY_ELEMENTS).
 */
function extractFields(body) {
  const out = emptyFields();
  const noClose = new Set();
  let pos = 0;
  let elements = 0;
  let haveIcon = false;
  let haveYear = false;
  let haveEpisode = false;
  let haveRating = false;
  while (pos < body.length && elements < MAX_BODY_ELEMENTS) {
    const lt = body.indexOf('<', pos);
    if (lt === -1) break;
    elements += 1;
    if (body.startsWith('<![CDATA[', lt)) {
      const end = body.indexOf(']]>', lt + 9);
      if (end === -1) break;
      pos = end + 3;
      continue;
    }
    if (body.startsWith('<!--', lt)) {
      const end = body.indexOf('-->', lt + 4);
      if (end === -1) break;
      pos = end + 3;
      continue;
    }
    TAG_NAME_RE.lastIndex = lt;
    const nameMatch = TAG_NAME_RE.exec(body);
    if (!nameMatch) {
      pos = lt + 1;
      continue;
    }
    const name = nameMatch[1];
    const tagEnd = findTagEnd(body, lt);
    if (tagEnd === -1) break;
    const attrText = body.slice(lt + 1 + name.length, tagEnd);
    const selfClosing = body[tagEnd - 1] === '/';
    const isField = FIELD_TAGS.has(name);
    if (!isField && !SKIP_CONTENT_TAGS.has(name)) {
      pos = tagEnd + 1; // z. B. <credits>: Kinder weiter scannen
      continue;
    }
    let content = '';
    let next = tagEnd + 1;
    if (!selfClosing && !noClose.has(name)) {
      const close = body.indexOf(`</${name}`, tagEnd + 1);
      if (close === -1) {
        noClose.add(name);
      } else {
        content = body.slice(tagEnd + 1, close);
        const closeEnd = body.indexOf('>', close);
        next = closeEnd === -1 ? body.length : closeEnd + 1;
      }
    }
    pos = next;
    if (!isField) continue;
    switch (name) {
      case 'category': {
        const text = textOf(content).slice(0, MAX_CATEGORY_LENGTH).trim();
        if (text && out.categories.length < MAX_CATEGORIES && !out.categories.includes(text)) out.categories.push(text);
        break;
      }
      case 'icon':
        // Nur das ERSTE <icon>: ist dessen URL unzulässig, bleibt das Bild leer (kein Weitersuchen)
        if (!haveIcon) {
          haveIcon = true;
          out.icon = parseIconUrl(attrOf(attrText, 'src'));
        }
        break;
      case 'date':
        if (!haveYear) {
          out.year = parseYear(textOf(content));
          haveYear = out.year !== 0;
        }
        break;
      case 'episode-num':
        if (!haveEpisode) {
          const system = attrOf(attrText, 'system').toLowerCase();
          const text = textOf(content);
          let episode = '';
          if (system === 'xmltv_ns') episode = episodeFromXmltvNs(text);
          else if (!system || system === 'onscreen') episode = text;
          out.episode = episode.slice(0, MAX_EPISODE_LENGTH).trim();
          haveEpisode = out.episode !== '';
        }
        break;
      case 'director':
        pushLimited(out.credits.director, textOf(content), MAX_DIRECTORS);
        break;
      case 'actor':
        pushLimited(out.credits.actor, textOf(content), MAX_ACTORS);
        break;
      case 'presenter':
        pushLimited(out.credits.presenter, textOf(content), MAX_PRESENTERS);
        break;
      case 'sub-title':
        if (!out.subtitle) out.subtitle = textOf(content).slice(0, MAX_SUBTITLE_LENGTH);
        break;
      case 'rating':
        if (!haveRating) {
          const value = firstChildText(content, 'value');
          out.rating = textOf(value !== null ? value : content).slice(0, MAX_RATING_LENGTH).trim();
          haveRating = out.rating !== '';
        }
        break;
      default:
        break;
    }
  }
  // Nichts Gespeichertes darf am Lese-Chunk hängen (siehe detach)
  out.categories = out.categories.map(detach);
  out.icon = detach(out.icon);
  out.episode = detach(out.episode);
  out.subtitle = detach(out.subtitle);
  out.rating = detach(out.rating);
  for (const list of Object.values(out.credits)) {
    for (let i = 0; i < list.length; i += 1) list[i] = detach(list[i]);
  }
  return out;
}

class XmltvStreamParser {
  /**
   * options:
   * - onProgramme({ channel, start, stop, title, desc, subtitle, categories, icon, year,
   *   episode, credits: { director, actor, presenter }, rating }): start/stop in UTC-ms;
   *   leere Felder: '' / [] / year 0
   * - fromMs/toMs: Zeitfenster; Sendungen außerhalb werden nicht geliefert
   */
  constructor({ onProgramme, fromMs = -Infinity, toMs = Infinity } = {}) {
    if (typeof onProgramme !== 'function') throw new Error('XmltvStreamParser benötigt onProgramme');
    this.onProgramme = onProgramme;
    this.fromMs = fromMs;
    this.toMs = toMs;
    this.buf = '';
    this.stats = { seen: 0, emitted: 0, skippedInvalid: 0, skippedOutOfWindow: 0, discardedOversized: 0 };
  }

  write(chunk) {
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    this.buf += chunk;
    this._drain();
  }

  end() {
    this._drain();
    this.buf = '';
  }

  _drain() {
    for (;;) {
      const open = this._findProgrammeStart(this.buf);
      if (open === -1) {
        // Nur ein möglicher Tag-Anfang ("<programm") bleibt erhalten
        const keep = this.buf.lastIndexOf('<');
        this.buf = keep === -1 || this.buf.length - keep > 12 ? '' : this.buf.slice(keep);
        return;
      }
      const tagEnd = findTagEnd(this.buf, open);
      if (tagEnd === -1) {
        this._dropIfOversized(open);
        this.buf = this.buf.slice(open);
        return;
      }
      const selfClosing = this.buf[tagEnd - 1] === '/';
      const startTag = this.buf.slice(open, tagEnd + 1);
      if (selfClosing) {
        this.stats.seen += 1;
        this.stats.skippedInvalid += 1;
        this.buf = this.buf.slice(tagEnd + 1);
        continue;
      }
      const close = this.buf.indexOf('</programme', tagEnd + 1);
      if (close === -1) {
        if (this.buf.length - open > MAX_OPEN_ELEMENT_CHARS) {
          this.stats.seen += 1;
          this.stats.discardedOversized += 1;
          this.buf = this.buf.slice(tagEnd + 1);
          continue;
        }
        this.buf = this.buf.slice(open);
        return;
      }
      const body = this.buf.slice(tagEnd + 1, close);
      this._handleProgramme(startTag, body);
      const closeEnd = this.buf.indexOf('>', close);
      if (closeEnd === -1) {
        this.buf = this.buf.slice(close);
        return;
      }
      this.buf = this.buf.slice(closeEnd + 1);
    }
  }

  _dropIfOversized(open) {
    if (this.buf.length - open > MAX_OPEN_ELEMENT_CHARS) {
      this.stats.seen += 1;
      this.stats.discardedOversized += 1;
      this.buf = '';
    }
  }

  /**
   * Findet "<programme" gefolgt von Whitespace oder '>' (nicht "<programmes").
   */
  _findProgrammeStart(buf) {
    let from = 0;
    for (;;) {
      const i = buf.indexOf('<programme', from);
      if (i === -1) return -1;
      const next = buf[i + '<programme'.length];
      if (next === undefined) return i; // Puffer endet mitten im Tag: später entscheiden
      if (/[\s>/]/.test(next)) return i;
      from = i + 1;
    }
  }

  _handleProgramme(startTag, body) {
    this.stats.seen += 1;
    const attrs = readAttributes(startTag);
    const start = parseXmltvTime(attrs.start);
    const stop = parseXmltvTime(attrs.stop);
    const title = firstElementText(body, TITLE_RE);
    if (!attrs.channel || !Number.isFinite(start) || !Number.isFinite(stop) || stop <= start || !title) {
      this.stats.skippedInvalid += 1;
      return;
    }
    if (stop <= this.fromMs || start >= this.toMs) {
      this.stats.skippedOutOfWindow += 1;
      return;
    }
    this.stats.emitted += 1;
    this.onProgramme({
      channel: attrs.channel,
      start,
      stop,
      title: detach(title.slice(0, MAX_TITLE_LENGTH)),
      desc: detach(firstElementText(body, DESC_RE).slice(0, MAX_DESC_LENGTH)),
      ...extractFields(body),
    });
  }
}

module.exports = {
  XmltvStreamParser,
  parseXmltvTime,
  decodeXmlEntities,
  textOf,
  LIMITS: {
    MAX_TITLE_LENGTH,
    MAX_DESC_LENGTH,
    MAX_CATEGORIES,
    MAX_CATEGORY_LENGTH,
    MAX_ICON_LENGTH,
    MAX_EPISODE_LENGTH,
    MAX_DIRECTORS,
    MAX_ACTORS,
    MAX_PRESENTERS,
    MAX_PERSON_LENGTH,
    MAX_SUBTITLE_LENGTH,
    MAX_RATING_LENGTH,
    MAX_BODY_ELEMENTS,
    MAX_OPEN_ELEMENT_CHARS,
  },
};
