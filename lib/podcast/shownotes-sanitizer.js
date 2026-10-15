'use strict';

// HTML -> Shownotes-Baum (Main-Prozess). Ein linearer Tokenizer mit Stapel (kein Regex über offene Tags, kein DOM), daher kein
// ReDoS: Eingabe höchstens 200 000 Zeichen, höchstens 5000 Elemente, Tiefe höchstens 30, Tags höchstens 2000 Zeichen lang.
// Allowlist (Tags/Attribute) steht in shownotes-schema.js; alles andere entfällt (Inhalt unbekannter Elemente bleibt,
// script/style/iframe/object/embed/audio/video/form/input/svg/math/link/meta/base verschwinden samt Inhalt). Nackte Adressen
// in Klartext-Shownotes werden zu Links. Das Ergebnis ist ein JSON-Baum, nie HTML.

const { decodeEntities } = require('./html-entities.js');
const { MAX_ELEMENTS, MAX_DEPTH, MAX_TEXT_TOTAL, VOID_TAGS, TABLE_CELLS, TAGS, TAG_ALIASES, stripUnsafe, safeUrl, cleanAttrs } = require('./shownotes-schema.js');

const MAX_INPUT = 200000;
const MAX_TAG_LENGTH = 2000;
const MAX_ATTRS = 24;
const RAW_TEXT = new Set(['script', 'style', 'iframe', 'textarea', 'title', 'noscript', 'xmp', 'template', 'noembed', 'noframes']);
const DROP_WITH_CONTENT = new Set(['svg', 'math', 'object', 'embed', 'audio', 'video', 'form', 'select', 'button', 'head', 'applet', 'canvas', 'map', 'frameset']);
const HTML_VOID = new Set(['br', 'hr', 'img', 'input', 'link', 'meta', 'base', 'area', 'col', 'embed', 'source', 'track', 'wbr', 'param', 'basefont', 'frame', 'keygen']);
const BLOCK_CLOSES_P = new Set(['address', 'blockquote', 'div', 'dl', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ol', 'p', 'pre', 'table', 'ul']);
const P_SCOPE_BOUNDARY = new Set(['table', 'td', 'th', 'caption']);
const WHITESPACE_ONLY_PARENTS = new Set(['ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'dl']);
const KEEP_EMPTY = new Set(['td', 'th', 'br', 'hr', 'img', 'tr', 'li', 'dt', 'dd']);
const BLOCKISH = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'figure', 'figcaption']);
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;
const ATTR_RE = /[\s/]*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

function isLetter(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** Ende des Tags ab lt (Index von ">") unter Beachtung von Anführungszeichen; -1, wenn keiner innerhalb des Limits. */
function tagEnd(text, lt) {
  const limit = Math.min(text.length, lt + MAX_TAG_LENGTH);
  let quote = 0;
  for (let i = lt + 1; i < limit; i += 1) {
    const code = text.charCodeAt(i);
    if (quote) {
      if (code === quote) quote = 0;
    } else if (code === 34 || code === 39) {
      // Anführungszeichen öffnen nur direkt nach "=" (bzw. Leerraum danach), sonst Text im Tag
      let j = i - 1;
      while (j > lt && text.charCodeAt(j) <= 32) j -= 1;
      if (text.charCodeAt(j) === 61) quote = code;
    } else if (code === 62) {
      return i;
    }
  }
  return -1;
}

function parseAttrs(source) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  for (let count = 0; count < MAX_ATTRS && ATTR_RE.lastIndex < source.length; count += 1) {
    const m = ATTR_RE.exec(source);
    if (!m) break;
    const name = m[1].toLowerCase();
    if (!Object.hasOwn(attrs, name)) {
      const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
      attrs[name] = decodeEntities(raw.slice(0, 2500));
    }
  }
  return attrs;
}

function createBuilder() {
  const root = { t: '#root', c: [] };
  const stack = [root];
  const state = { elements: 0, text: 0, full: false };

  const top = () => stack[stack.length - 1];
  const inPre = () => stack.some(node => node.t === 'pre');

  function popTo(index) {
    stack.length = index;
  }

  function closeByName(name, boundaries) {
    for (let i = stack.length - 1; i > 0; i -= 1) {
      const tag = stack[i].t;
      if (tag === name) {
        popTo(i);
        return true;
      }
      if (boundaries.has(tag)) return false;
    }
    return false;
  }

  function implicitClose(name) {
    if (BLOCK_CLOSES_P.has(name)) closeByName('p', P_SCOPE_BOUNDARY);
    if (name === 'li') closeByName('li', new Set(['ul', 'ol', 'table']));
    else if (name === 'dt' || name === 'dd') {
      if (!closeByName('dt', new Set(['dl', 'table']))) closeByName('dd', new Set(['dl', 'table']));
    } else if (name === 'tr') closeByName('tr', new Set(['table']));
    else if (TABLE_CELLS.has(name)) {
      if (!closeByName('td', new Set(['tr', 'table']))) closeByName('th', new Set(['tr', 'table']));
    } else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
      closeByName('thead', new Set(['table'])) || closeByName('tbody', new Set(['table'])) || closeByName('tfoot', new Set(['table']));
    }
  }

  function open(name, rawAttrs, selfClosing) {
    const tag = Object.hasOwn(TAG_ALIASES, name) ? TAG_ALIASES[name] : name;
    if (!TAGS.has(tag)) return; // unbekanntes Element: Tag entfällt, Inhalt bleibt
    if (state.elements >= MAX_ELEMENTS) {
      state.full = true;
      return;
    }
    if (VOID_TAGS.has(tag)) {
      if (tag === 'img') {
        const attrs = cleanAttrs('img', rawAttrs);
        if (attrs && attrs.src) {
          state.elements += 1;
          top().c.push({ t: 'img', a: attrs });
        } else if (typeof rawAttrs.alt === 'string' && rawAttrs.alt.trim()) {
          text(stripUnsafe(rawAttrs.alt).slice(0, 300));
        }
        return;
      }
      state.elements += 1;
      top().c.push({ t: tag });
      return;
    }
    implicitClose(tag);
    if (stack.length > MAX_DEPTH) return; // zu tief: Tag entfällt, Inhalt bleibt in der aktuellen Ebene
    if (tag === 'a') {
      if (stack.some(node => node.t === 'a')) return; // Links nicht schachteln
      const attrs = cleanAttrs('a', rawAttrs);
      if (!attrs || !attrs.href) return; // ohne gültige Adresse: nur der Text
      state.elements += 1;
      const node = { t: 'a', a: attrs, c: [] };
      top().c.push(node);
      stack.push(node);
      return;
    }
    state.elements += 1;
    const node = { t: tag, c: [] };
    const attrs = cleanAttrs(tag, rawAttrs);
    if (attrs) node.a = attrs;
    top().c.push(node);
    if (!selfClosing) stack.push(node);
  }

  function close(name) {
    const tag = Object.hasOwn(TAG_ALIASES, name) ? TAG_ALIASES[name] : name;
    if (!TAGS.has(tag) || VOID_TAGS.has(tag)) return;
    for (let i = stack.length - 1; i > 0; i -= 1) {
      if (stack[i].t === tag) {
        popTo(i);
        return;
      }
    }
  }

  function text(value) {
    if (!value || state.text >= MAX_TEXT_TOTAL) return;
    let clean = stripUnsafe(value);
    if (!inPre()) clean = clean.replace(/[ \t\r\n\f]+/g, ' ');
    else clean = clean.replace(/\r\n?/g, '\n');
    if (!clean) return;
    clean = clean.slice(0, MAX_TEXT_TOTAL - state.text);
    state.text += clean.length;
    const children = top().c;
    const last = children[children.length - 1];
    if (typeof last === 'string') children[children.length - 1] = last + clean;
    else children.push(clean);
  }

  return { root, open, close, text, state };
}

/** Abschlussbereinigung: Leerraum zwischen Strukturelementen entfernen, Blockränder trimmen, leere Elemente entfernen. Tiefe ≤ 31. */
function tidy(node, pre) {
  const isPre = pre || node.t === 'pre';
  const result = [];
  for (const child of node.c) {
    if (typeof child === 'string') {
      if (!isPre && WHITESPACE_ONLY_PARENTS.has(node.t) && !child.trim()) continue;
      result.push(child);
    } else {
      child.c = child.c ? tidy(child, isPre) : child.c;
      if (child.c && !child.c.length && !KEEP_EMPTY.has(child.t)) continue;
      result.push(child);
    }
  }
  if (!isPre && (BLOCKISH.has(node.t) || node.t === '#root')) {
    if (typeof result[0] === 'string') {
      result[0] = result[0].replace(/^ +/, '');
      if (!result[0]) result.shift();
    }
    const last = result.length - 1;
    if (typeof result[last] === 'string') {
      result[last] = result[last].replace(/ +$/, '');
      if (!result[last]) result.pop();
    }
  }
  // Leerraum direkt vor/nach einem Zeilenumbruch oder Blockelement fällt weg
  if (!isPre) {
    for (let i = 0; i < result.length; i += 1) {
      const item = result[i];
      if (typeof item !== 'string') continue;
      const prev = result[i - 1];
      const next = result[i + 1];
      let value = item;
      if (prev && typeof prev === 'object' && (prev.t === 'br' || BLOCKISH.has(prev.t) || prev.t === 'hr')) value = value.replace(/^ +/, '');
      if (next && typeof next === 'object' && (next.t === 'br' || BLOCKISH.has(next.t) || next.t === 'hr')) value = value.replace(/ +$/, '');
      if (value !== item) result[i] = value;
    }
    return result.filter(item => item !== '');
  }
  return result;
}

function linkifyText(value) {
  const nodes = [];
  let pos = 0;
  URL_IN_TEXT.lastIndex = 0;
  for (let m = URL_IN_TEXT.exec(value); m; m = URL_IN_TEXT.exec(value)) {
    let url = m[0];
    const trailing = /[.,;:!?)\]}»”’]+$/.exec(url);
    if (trailing) url = url.slice(0, url.length - trailing[0].length);
    const safe = safeUrl(url, 'link');
    if (!safe) continue;
    if (m.index > pos) nodes.push(value.slice(pos, m.index));
    nodes.push({ t: 'a', a: { href: safe }, c: [url] });
    pos = m.index + url.length;
    URL_IN_TEXT.lastIndex = pos;
  }
  if (pos < value.length) nodes.push(value.slice(pos));
  return nodes;
}

/** Klartext -> Absätze (Leerzeile), Zeilenumbrüche als <br>, nackte http/https-Adressen als Links. */
function plainTextToTree(text) {
  const tree = [];
  let elements = 0;
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    if (!block.trim() || elements >= MAX_ELEMENTS) continue;
    const paragraph = { t: 'p', c: [] };
    const lines = block.split('\n');
    lines.forEach((line, index) => {
      const clean = stripUnsafe(line).replace(/[ \t]+/g, ' ').trim();
      if (index > 0 && clean) paragraph.c.push({ t: 'br' });
      if (clean) paragraph.c.push(...linkifyText(clean));
    });
    elements += paragraph.c.length + 1;
    if (paragraph.c.length) tree.push(paragraph);
  }
  return tree;
}

/** Roh-HTML -> Baum (Array von Knoten). Wirft nie; ungültige Eingabe liefert []. */
function htmlToTree(input) {
  if (typeof input !== 'string' || !input) return [];
  const html = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input;
  const builder = createBuilder();
  const { open, close, text, state } = builder;
  const length = html.length;
  let pos = 0;
  let skip = null; // { name, depth }: Inhalt eines verworfenen Elements

  while (pos < length && !state.full && state.text < MAX_TEXT_TOTAL) {
    const lt = html.indexOf('<', pos);
    if (lt < 0) {
      if (!skip) text(decodeEntities(html.slice(pos)));
      break;
    }
    if (lt > pos && !skip) text(decodeEntities(html.slice(pos, lt)));
    const next = html.charCodeAt(lt + 1);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break; // unbeendeter Kommentar: Rest verwerfen
      pos = end + 3;
      continue;
    }
    if (next === 33 || next === 63) {
      // <!DOCTYPE …>, <![CDATA[…]]> (im Inhalt), <?…>
      if (html.startsWith('<![CDATA[', lt)) {
        const end = html.indexOf(']]>', lt + 9);
        if (!skip) text(html.slice(lt + 9, end < 0 ? length : end));
        pos = end < 0 ? length : end + 3;
        continue;
      }
      const end = html.indexOf('>', lt + 1);
      pos = end < 0 ? length : end + 1;
      continue;
    }
    const closing = next === 47;
    const nameStart = lt + (closing ? 2 : 1);
    if (!isLetter(html.charCodeAt(nameStart))) {
      if (!skip) text('<');
      pos = lt + 1;
      continue;
    }
    const gt = tagEnd(html, lt);
    if (gt < 0) {
      if (html.length - lt <= MAX_TAG_LENGTH) break; // unvollständiges Tag am Ende: verwerfen
      if (!skip) text('<');
      pos = lt + 1;
      continue;
    }
    const body = html.slice(nameStart, gt);
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]{0,31}/.exec(body);
    if (!nameMatch) {
      pos = gt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    pos = gt + 1;

    if (skip) {
      if (name === skip.name) {
        if (closing) skip.depth -= 1;
        else if (!body.endsWith('/')) skip.depth += 1;
        if (skip.depth <= 0) skip = null;
      }
      continue;
    }
    if (closing) {
      close(name);
      continue;
    }
    const selfClosing = body.endsWith('/') || HTML_VOID.has(name);
    if (RAW_TEXT.has(name) || DROP_WITH_CONTENT.has(name)) {
      if (selfClosing) continue;
      if (RAW_TEXT.has(name)) {
        const closeRe = new RegExp(`</${name}[\\s/>]`, 'gi');
        closeRe.lastIndex = pos;
        const found = closeRe.exec(html);
        if (!found) {
          break; // ohne schließendes Tag gehört der Rest zum Element
        }
        const end = html.indexOf('>', found.index);
        pos = end < 0 ? length : end + 1;
      } else {
        skip = { name, depth: 1 };
      }
      continue;
    }
    if (HTML_VOID.has(name) && !TAGS.has(name)) continue;
    const attrSource = body.slice(nameMatch[0].length);
    open(name, name === 'a' || name === 'img' || name === 'td' || name === 'th' ? parseAttrs(attrSource) : {}, selfClosing);
  }
  return tidy(builder.root, false);
}

/** Leitet reinen Text aus einem Baum ab (Absätze, Listenpunkte), höchstens max Zeichen. */
function treeToText(tree, max = 500) {
  const parts = [];
  let length = 0;
  const stack = [[Array.isArray(tree) ? tree : [], 0]];
  while (stack.length && length < max) {
    const frame = stack[stack.length - 1];
    if (frame[1] >= frame[0].length) {
      stack.pop();
      continue;
    }
    const node = frame[0][frame[1]];
    frame[1] += 1;
    if (typeof node === 'string') {
      parts.push(node);
      length += node.length;
    } else if (node && typeof node === 'object') {
      const lineBreak = () => {
        if (parts.length && !/\n$/.test(parts[parts.length - 1])) parts.push('\n');
      };
      if (node.t === 'br') parts.push('\n');
      else if (node.t === 'li') {
        lineBreak();
        parts.push('• ');
      } else if (BLOCKISH.has(node.t)) lineBreak();
      if (Array.isArray(node.c) && stack.length < MAX_DEPTH + 3) stack.push([node.c, 0]);
    }
  }
  const joined = parts.join('').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return joined.length > max ? `${joined.slice(0, max - 1).trimEnd()}…` : joined;
}

function countElements(tree) {
  let count = 0;
  const stack = [tree];
  while (stack.length) {
    for (const node of stack.pop()) {
      if (node && typeof node === 'object') {
        count += 1;
        if (node.c) stack.push(node.c);
      }
    }
  }
  return count;
}

/** Roh-Feldinhalt (evtl. CDATA, evtl. HTML, evtl. als Entities maskiertes HTML, evtl. Klartext) -> Baum. */
function sanitizeShownotes(raw) {
  if (raw === null || raw === undefined) return [];
  let value = String(raw).slice(0, MAX_INPUT * 2);
  const trimmed = value.trim();
  if (trimmed.startsWith('<![CDATA[') && trimmed.endsWith(']]>') && trimmed.length >= 12) {
    value = trimmed.slice(9, -3);
  } else if (!value.includes('<') && /&(?:lt|#0*60|#x0*3c);/i.test(value)) {
    value = decodeEntities(value); // als Entities maskiertes HTML (üblich in <description>)
  } else if (value.includes('<![CDATA[')) {
    value = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner) => inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    value = value.length > MAX_INPUT * 2 ? value.slice(0, MAX_INPUT * 2) : value;
  }
  value = value.slice(0, MAX_INPUT);
  if (!value.trim()) return [];
  if (/<\/?[a-zA-Z]/.test(value)) return htmlToTree(value);
  return plainTextToTree(decodeEntities(value).slice(0, MAX_TEXT_TOTAL));
}

/** Wählt unter mehreren Roh-Feldern das reichhaltigste: meiste Textmenge plus Struktur; bei Gleichstand das frühere. */
function pickShownotes(fields) {
  let best = [];
  let bestScore = 0;
  for (const raw of fields) {
    if (raw === null || raw === undefined || !String(raw).trim()) continue;
    const tree = sanitizeShownotes(raw);
    if (!tree.length) continue;
    const score = treeToText(tree, 20000).length + countElements(tree) * 20;
    if (score > bestScore * 1.05 || !best.length) {
      best = tree;
      bestScore = score;
    }
  }
  return best;
}

module.exports = { sanitizeShownotes, pickShownotes, htmlToTree, plainTextToTree, treeToText, MAX_INPUT };
