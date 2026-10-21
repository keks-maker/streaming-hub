'use strict';

// Hilfsfunktionen für die Theme-Tests: liest die Farb-Tokens aus den theme-literal-Bereichen der CSS-Dateien,
// löst light-dark()/var() auf und berechnet WCAG-Kontraste. Reiner Text- und Rechenzugriff, kein DOM nötig.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const START = 'theme-literal:start';
const END = 'theme-literal:end';

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

// Zerlegt den Text in die markierten Bereiche (Farbliterale erlaubt) und den Rest.
function splitRegions(text) {
  const allowed = [];
  let rest = '';
  let pos = 0;
  for (;;) {
    const s = text.indexOf(START, pos);
    if (s === -1) { rest += text.slice(pos); break; }
    const sLineStart = text.lastIndexOf('/*', s);
    rest += text.slice(pos, sLineStart);
    const e = text.indexOf(END, s);
    if (e === -1) throw new Error('theme-literal:start ohne :end');
    const eClose = text.indexOf('*/', e) + 2;
    allowed.push(text.slice(text.indexOf('*/', s) + 2, text.lastIndexOf('/*', e)));
    pos = eClose;
  }
  return { allowed, rest };
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Alle Deklarationswerte (Text zwischen ':' und ';' bzw. '}') außerhalb von Selektoren.
function declarations(text) {
  const out = [];
  let buf = '';
  let line = 1;
  let startLine = 1;
  for (const ch of stripComments(text)) {
    if (ch === '\n') line += 1;
    if (ch === '{') { buf = ''; startLine = line; continue; }
    if (ch === ';' || ch === '}') {
      if (buf.trim()) out.push({ text: buf.trim(), line: startLine });
      buf = '';
      startLine = line;
      continue;
    }
    if (!buf.trim()) startLine = line;
    buf += ch;
  }
  return out;
}

// Farbliterale in einem Wert (Token-Definitionen ausgenommen).
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d|(?<![-\w#])(?:white|black)(?![-\w])/;

function findLiterals(text) {
  const { rest } = splitRegions(text);
  const hits = [];
  for (const d of declarations(rest)) {
    const colon = d.text.indexOf(':');
    if (colon === -1) continue;
    const value = d.text.slice(colon + 1);
    if (LITERAL.test(value)) hits.push(`${d.text.slice(0, 110)}`);
  }
  return hits;
}

// --- Farbrechnung ---------------------------------------------------------

function splitTop(str, sep = ',') {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === sep && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function parseColor(str) {
  const s = str.trim();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map(c => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = s.match(/^rgba?\(([^)]*)\)$/i);
  if (m) {
    const p = m[1].split(',').map(x => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}

// Tokens aus den markierten Bereichen: { name: Wert-Text }
function collectTokens(files = ['styles.css']) {
  const tokens = {};
  for (const f of files) {
    const { allowed } = splitRegions(read(f));
    for (const region of allowed) {
      for (const d of declarations(region)) {
        const m = d.text.match(/^(--[\w-]+)\s*:\s*([\s\S]+)$/);
        if (m) tokens[m[1]] = m[2].trim().replace(/\s+/g, ' ');
      }
    }
  }
  return tokens;
}

// Löst einen Tokenwert für ein Schema auf. Liefert {r,g,b,a} oder null (z. B. Gradient/Schatten).
function resolve(value, tokens, scheme, depth = 0) {
  if (depth > 12) throw new Error(`Token-Zyklus: ${value}`);
  const v = value.trim();
  let m = v.match(/^var\((--[\w-]+)\)$/);
  if (m) {
    if (!(m[1] in tokens)) throw new Error(`Unbekanntes Token ${m[1]}`);
    return resolve(tokens[m[1]], tokens, scheme, depth + 1);
  }
  m = v.match(/^light-dark\((.*)\)$/);
  if (m) {
    const [light, dark] = splitTop(m[1]);
    return resolve(scheme === 'light' ? light : dark, tokens, scheme, depth + 1);
  }
  return parseColor(v);
}

function over(fg, bg) {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

function luminance(c) {
  const f = x => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

// Kontrast von fg (ggf. halbtransparent) auf der (ggf. halbtransparenten) Fläche bg über dem Seitenhintergrund base.
function contrast(fg, bg, base) {
  const surface = over(bg, base);
  const text = over(fg, surface);
  const l1 = luminance(text);
  const l2 = luminance(surface);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

module.exports = { read, splitRegions, findLiterals, collectTokens, resolve, contrast, over, parseColor, declarations, ROOT };
