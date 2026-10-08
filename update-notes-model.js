// Update-Dialog: Minimal-Markdown für GitHub-Release-Texte. Reine Funktionen ohne IPC.
// parseMarkdown liefert Blöcke, renderMarkdown baut daraus DOM ausschließlich per
// createElement/textContent (kein innerHTML mit Fremdtext). Unterstützt: Überschriften (#–###),
// Listen (-, *), **fett**, `code`, Absätze; Links erscheinen nur als Text.

'use strict';

const NO_DETAILS = 'Keine Details';

/** Inline-Segmente: [{ type: 'text' | 'bold' | 'code', text }]. Links [t](u) -> t, Bilder -> Alt-Text. */
function parseInline(source) {
  let text = String(source ?? '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<(https?:\/\/[^>\s]+)>/g, '$1');
  const out = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: 'code', text: m[1] });
    else out.push({ type: 'bold', text: m[2] ?? m[3] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/** Blöcke: heading {level 1-3, inline} | list {items: inline[][]} | paragraph {inline}. */
function parseMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', inline: parseInline(para.join(' ')) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: 'list', items: list });
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: 'heading', level: Math.min(heading[1].length, 3), inline: parseInline(heading[2].replace(/\s+#+$/, '')) });
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(trimmed);
    if (item) {
      flushPara();
      (list ||= []).push(parseInline(item[1]));
      continue;
    }
    flushList();
    para.push(trimmed);
  }
  flushPara();
  flushList();
  return blocks;
}

function appendInline(doc, parent, segments) {
  for (const seg of segments) {
    if (seg.type === 'text') {
      parent.appendChild(doc.createTextNode(seg.text));
    } else {
      const node = doc.createElement(seg.type === 'bold' ? 'strong' : 'code');
      node.textContent = seg.text;
      parent.appendChild(node);
    }
  }
}

/** Rendert Markdown in `parent` (Klassen update-md-*). Leerer Text -> "Keine Details". */
function renderMarkdown(doc, parent, markdown) {
  const blocks = parseMarkdown(markdown);
  if (!blocks.length) {
    const p = doc.createElement('p');
    p.className = 'update-md-p update-md-empty';
    p.textContent = NO_DETAILS;
    parent.appendChild(p);
    return;
  }
  for (const block of blocks) {
    if (block.type === 'heading') {
      const h = doc.createElement(`h${block.level + 3}`);
      h.className = `update-md-h update-md-h${block.level}`;
      appendInline(doc, h, block.inline);
      parent.appendChild(h);
    } else if (block.type === 'list') {
      const ul = doc.createElement('ul');
      ul.className = 'update-md-list';
      for (const inline of block.items) {
        const li = doc.createElement('li');
        appendInline(doc, li, inline);
        ul.appendChild(li);
      }
      parent.appendChild(ul);
    } else {
      const p = doc.createElement('p');
      p.className = 'update-md-p';
      appendInline(doc, p, block.inline);
      parent.appendChild(p);
    }
  }
}

/** Baut die Versionsabschnitte des Update-Dialogs (neueste zuerst, wie geliefert). */
function renderUpdateNotes(doc, parent, notes) {
  const list = Array.isArray(notes) ? notes : [];
  if (!list.length) {
    const p = doc.createElement('p');
    p.className = 'update-md-p update-md-empty';
    p.textContent = NO_DETAILS;
    parent.appendChild(p);
    return;
  }
  for (const note of list) {
    const section = doc.createElement('section');
    section.className = 'update-notes-version';
    const title = doc.createElement('h3');
    title.className = 'update-notes-title';
    const name = note && typeof note.name === 'string' && note.name.trim() && note.name.trim() !== `v${note.version}` ? ` – ${note.name.trim()}` : '';
    title.textContent = `Version ${note && note.version}${name}`;
    section.appendChild(title);
    renderMarkdown(doc, section, note && note.body);
    parent.appendChild(section);
  }
}

module.exports = { NO_DETAILS, parseInline, parseMarkdown, renderMarkdown, renderUpdateNotes };
