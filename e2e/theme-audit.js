'use strict';

// Hilfsmittel der Theme-Prüfung (hell/dunkel): Screenshots in beiden Systemdesigns und eine Kontrastprüfung aller sichtbaren
// Texte im gerenderten DOM (berechnete Farbe gegen die zusammengesetzte Hintergrundfarbe der Vorfahren). Flächen mit
// Verlauf/Bild werden übersprungen (unbekannter Untergrund). Wird nur für Nachweise genutzt (Env THEME_SHOTS=<Verzeichnis>),
// ändert nichts am Testverlauf und braucht kein Fenster im Vordergrund.
const fs = require('fs');
const path = require('path');

const SCHEMES = ['dark', 'light'];

// Läuft im Renderer: liefert Befunde { text, fg, bg, ratio, sel, size }.
function auditInPage(minRatio) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const parse = value => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const lum = c => {
    const f = x => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const mix = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, window.NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || seen.has(el) || ['SCRIPT', 'STYLE', 'OPTION', 'NOSCRIPT'].includes(el.tagName)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) continue;
    // sichtbar? (display/visibility/Deckkraft der Kette, hidden-Attribut)
    let visible = true;
    let opacity = 1;
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') { visible = false; break; }
      opacity *= parseFloat(cs.opacity);
    }
    if (!visible || opacity < 0.2) continue;
    // Element muss am Mittelpunkt auch oben liegen (verdeckte Bereiche überspringen)
    const cx = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const cy = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const top = document.elementFromPoint(cx, cy);
    if (!top || !(el.contains(top) || top.contains(el))) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const fgRaw = parse(cs.color);
    if (fgRaw.a < 0.05) continue; // unsichtbar (z. B. Platzhaltertext hinter Logo-Bild)
    // Hintergrund zusammensetzen
    const stack = [];
    let unknown = false;
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') { unknown = true; break; }
      const bg = parse(s.backgroundColor);
      if (bg.a > 0) stack.push(bg);
      if (bg.a >= 1) break;
    }
    if (unknown) continue;
    let base = { r: 255, g: 255, b: 255, a: 1 };
    const root = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (root.a > 0) base = mix(root, base);
    for (let i = stack.length - 1; i >= 0; i -= 1) base = mix(stack[i], base);
    const fg = mix({ ...fgRaw, a: fgRaw.a * Math.min(1, opacity) }, base);
    const [hi, lo] = lum(fg) > lum(base) ? [lum(fg), lum(base)] : [lum(base), lum(fg)];
    const ratio = (hi + 0.05) / (lo + 0.05);
    if (ratio < minRatio) {
      const size = parseFloat(cs.fontSize);
      const sel = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
      out.push({ text: text.slice(0, 40), sel, size, weight: cs.fontWeight, ratio: Math.round(ratio * 100) / 100, fg: `${fg.r | 0},${fg.g | 0},${fg.b | 0}`, bg: `${base.r | 0},${base.g | 0},${base.b | 0}` });
    }
  }
  return out;
}

// Screenshot + Kontrastprüfung in beiden Designs; Befunde landen in <dir>/audit.txt.
async function shotBoth(page, dir, name, { minRatio = 3 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const findings = [];
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(dir, `${name}-${scheme}.png`) });
    const list = await page.evaluate(auditInPage, minRatio);
    for (const f of list) findings.push(`${name} [${scheme}] ${f.ratio}:1 ${f.sel} "${f.text}" ${f.size}px/${f.weight} fg(${f.fg}) bg(${f.bg})`);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  if (findings.length) fs.appendFileSync(path.join(dir, 'audit.txt'), `${findings.join('\n')}\n`);
  return findings;
}

module.exports = { shotBoth, auditInPage, SCHEMES };
