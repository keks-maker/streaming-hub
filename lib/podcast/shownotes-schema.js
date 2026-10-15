'use strict';

// Gemeinsames Schema der Shownotes-Bäume (Main-Sanitizer, IPC, Renderer). Ein Baum ist ein Array aus Knoten:
//   Text      = String
//   Element   = { t: Tag, a?: { href|src|alt|title|width|height|colspan|rowspan }, c?: [Knoten] }
// Erlaubt sind nur die Tags und Attribute dieser Datei; cleanTree() prüft einen (evtl. nicht vertrauenswürdigen) Baum erneut
// und liefert eine bereinigte Kopie. Adressen: Links nur http/https/mailto, Bilder nur http/https, nie userinfo.

const MAX_URL_LENGTH = 2048;
const MAX_ELEMENTS = 5000;
const MAX_DEPTH = 30;
const MAX_TEXT_TOTAL = 60000;
const MAX_ATTR_TEXT = 300;
const MAX_SPAN = 20;
const MAX_DIMENSION = 4000;

const VOID_TAGS = new Set(['br', 'hr', 'img']);
const TABLE_CELLS = new Set(['td', 'th']);
const TAGS = new Set([
  'p', 'br', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code', 'hr',
  'strong', 'em', 'u', 's', 'del', 'ins', 'sub', 'sup', 'small', 'mark', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'figure', 'figcaption', 'a', 'img',
]);
// Schreibweisen, die auf ein kanonisches Tag abgebildet werden
const TAG_ALIASES = { b: 'strong', i: 'em', strike: 's' };
const ALLOWED_ATTRS = { a: ['href', 'title'], img: ['src', 'alt', 'title', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] };

/** Zeichenklasse aus Codepoint-Bereichen (als Zahlen, damit keine unsichtbaren Zeichen im Quelltext stehen). */
function codePointClass(ranges, flags = 'g') {
  const esc = code => `\\u${code.toString(16).padStart(4, '0')}`;
  return new RegExp(`[${ranges.map(([from, to]) => (to === undefined ? esc(from) : `${esc(from)}-${esc(to)}`)).join('')}]`, flags);
}

// Zeichen, die Adressen und Texte nie enthalten dürfen (Steuerzeichen, Bidi-Überschreibungen, Zero-Width)
const UNSAFE_CHARS = codePointClass([[0, 8], [0xb], [0xc], [0xe, 0x1f], [0x7f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff]]);

/** Text ohne Steuer- und Bidi-Zeichen. */
// Rand einer Adresse (Steuerzeichen und Leerzeichen, wie im URL-Standard) und unzulässige Zeichen im Inneren
/** Steuerzeichen und Leerzeichen am Rand entfernen (linear, ohne Regex mit "$"). */
function trimEdges(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end -= 1;
  return text.slice(start, end);
}
const INNER_UNSAFE = new RegExp(`${codePointClass([[0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff], [0x5c]], '').source}`);

function stripUnsafe(text) {
  return String(text).replace(UNSAFE_CHARS, '');
}

/**
 * Adresse prüfen und normalisieren. allowed: 'link' (http, https, mailto) oder 'image' (http, https). Gibt die normalisierte
 * Adresse oder null zurück. Das Schema wird nach Entfernen von Steuer- und Leerzeichen am Rand und von Tabs/Zeilenumbrüchen
 * im Inneren (wie es Browser tun) geprüft; relative, javascript:-, data:-, file:-, vbscript:-Adressen und userinfo entfallen.
 */
function safeUrl(value, allowed = 'link') {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH * 2) return null;
  const trimmed = trimEdges(value).replace(/[\t\n\r]/g, '');
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  if (INNER_UNSAFE.test(trimmed)) return null;
  const web = /^https?:\/\/[^/?#\s]/i.test(trimmed);
  const mail = allowed === 'link' && /^mailto:[^\s]+$/i.test(trimmed);
  if (!web && !mail) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (web) {
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !url.hostname) return null;
  } else if (url.protocol !== 'mailto:' || !url.pathname) {
    return null;
  }
  const href = url.href;
  return href.length <= MAX_URL_LENGTH ? href : null;
}

function smallInt(value, max) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,5}$/.test(text.trim())) return null;
  const number = Number(text.trim());
  return number >= 1 && number <= max ? number : null;
}

/** Attribute eines Tags prüfen (Eingabe: Rohwerte als Objekt); liefert { ... } mit nur gültigen Feldern oder null. */
function cleanAttrs(tag, attrs) {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed || !attrs || typeof attrs !== 'object') return null;
  const out = {};
  for (const name of allowed) {
    const value = Object.hasOwn(attrs, name) ? attrs[name] : undefined;
    if (value === undefined || value === null) continue;
    if (name === 'href') {
      const href = safeUrl(value, 'link');
      if (href) out.href = href;
    } else if (name === 'src') {
      const src = safeUrl(value, 'image');
      if (src) out.src = src;
    } else if (name === 'width' || name === 'height') {
      const number = smallInt(value, MAX_DIMENSION);
      if (number) out[name] = number;
    } else if (name === 'colspan' || name === 'rowspan') {
      const number = smallInt(value, MAX_SPAN);
      if (number) out[name] = number;
    } else if (typeof value === 'string') {
      const text = stripUnsafe(value).replace(/\s+/g, ' ').trim().slice(0, MAX_ATTR_TEXT);
      if (text) out[name] = text;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Prüft einen Baum erneut (Allowlist, Grenzen) und liefert eine bereinigte Kopie. Unbekannte Elemente: Inhalt bleibt,
 * Tag entfällt. Nie rekursiv tiefer als MAX_DEPTH, höchstens MAX_ELEMENTS Elemente und MAX_TEXT_TOTAL Zeichen Text.
 */
function cleanTree(tree) {
  const budget = { elements: 0, text: 0 };
  const out = [];
  if (Array.isArray(tree)) cleanChildren(tree, 0, budget, out);
  return out;
}

function cleanChildren(list, depth, budget, out) {
  if (depth > MAX_DEPTH * 2) return;
  for (const node of list) {
    if (budget.elements >= MAX_ELEMENTS || budget.text >= MAX_TEXT_TOTAL) return;
    if (typeof node === 'string') {
      const text = stripUnsafe(node).slice(0, MAX_TEXT_TOTAL - budget.text);
      if (text) {
        budget.text += text.length;
        out.push(text);
      }
      continue;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.t !== 'string') continue;
    const tag = Object.hasOwn(TAG_ALIASES, node.t) ? TAG_ALIASES[node.t] : node.t;
    const children = Array.isArray(node.c) ? node.c : [];
    if (!TAGS.has(tag) || depth >= MAX_DEPTH) {
      cleanChildren(children, depth + 1, budget, out); // Tag verwerfen, Inhalt behalten
      continue;
    }
    if (tag === 'img') {
      const attrs = cleanAttrs('img', node.a);
      if (!attrs || !attrs.src) {
        if (node.a && typeof node.a.alt === 'string' && stripUnsafe(node.a.alt).trim()) cleanChildren([node.a.alt.slice(0, MAX_ATTR_TEXT)], depth, budget, out);
        continue;
      }
      budget.elements += 1;
      out.push({ t: 'img', a: attrs });
      continue;
    }
    if (tag === 'a') {
      const attrs = cleanAttrs('a', node.a);
      if (!attrs || !attrs.href) {
        cleanChildren(children, depth, budget, out); // ungültige Adresse: nur der Text bleibt
        continue;
      }
      budget.elements += 1;
      const element = { t: 'a', a: attrs, c: [] };
      cleanChildren(children, depth + 1, budget, element.c);
      out.push(element);
      continue;
    }
    budget.elements += 1;
    const element = { t: tag };
    const attrs = cleanAttrs(tag, node.a);
    if (attrs) element.a = attrs;
    if (!VOID_TAGS.has(tag)) {
      element.c = [];
      cleanChildren(children, depth + 1, budget, element.c);
    }
    out.push(element);
  }
}

/** Bild-Adressen eines Baums in Dokumentreihenfolge (ohne Duplikate), höchstens max. */
function collectImageUrls(tree, max = 20) {
  const urls = [];
  const seen = new Set();
  const stack = Array.isArray(tree) ? [[tree, 0]] : [];
  while (stack.length && urls.length < max) {
    const [list, index] = stack[stack.length - 1];
    if (index >= list.length) {
      stack.pop();
      continue;
    }
    stack[stack.length - 1][1] += 1;
    const node = list[index];
    if (!node || typeof node !== 'object') continue;
    if (node.t === 'img' && node.a && typeof node.a.src === 'string' && !seen.has(node.a.src)) {
      seen.add(node.a.src);
      urls.push(node.a.src);
    }
    if (Array.isArray(node.c) && stack.length < MAX_DEPTH + 2) stack.push([node.c, 0]);
  }
  return urls;
}

module.exports = {
  MAX_URL_LENGTH,
  MAX_ELEMENTS,
  MAX_DEPTH,
  MAX_TEXT_TOTAL,
  MAX_ATTR_TEXT,
  VOID_TAGS,
  TABLE_CELLS,
  TAGS,
  TAG_ALIASES,
  ALLOWED_ATTRS,
  stripUnsafe,
  safeUrl,
  cleanAttrs,
  cleanTree,
  collectImageUrls,
};
