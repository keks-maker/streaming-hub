'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdown, parseInline, renderMarkdown, renderUpdateNotes } = require('../update-notes-model.js');

// Minimales Fake-DOM: protokolliert Tags und textContent; innerHTML-Zugriff wäre ein Fehler.
function makeDoc() {
  const make = tag => ({
    tag,
    children: [],
    className: '',
    _text: '',
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
    set innerHTML(_) { throw new Error('innerHTML verboten'); },
    appendChild(c) { this.children.push(c); return c; },
  });
  return { createElement: make, createTextNode: t => ({ tag: '#text', children: [], get textContent() { return t; } }) };
}

test('Überschriften, Listen und Absätze werden erkannt', () => {
  const blocks = parseMarkdown('# A\n## B\n#### C\n\nText eins\nText zwei\n\n- x\n* y\n');
  assert.deepEqual(blocks.map(b => b.type), ['heading', 'heading', 'heading', 'paragraph', 'list']);
  assert.deepEqual(blocks.slice(0, 3).map(b => b.level), [1, 2, 3]);
  assert.equal(blocks[3].inline[0].text, 'Text eins Text zwei');
  assert.equal(blocks[4].items.length, 2);
});

test('Inline: fett, code, Links nur als Text', () => {
  assert.deepEqual(parseInline('a **b** `c` [Link](http://x.y) d'), [
    { type: 'text', text: 'a ' }, { type: 'bold', text: 'b' }, { type: 'text', text: ' ' },
    { type: 'code', text: 'c' }, { type: 'text', text: ' Link d' },
  ]);
});

test('HTML im Fremdtext bleibt Text (kein Element, kein innerHTML)', () => {
  const doc = makeDoc();
  const root = doc.createElement('div');
  renderMarkdown(doc, root, '<img src=x onerror=alert(1)>\n\n- <script>alert(1)</script>');
  assert.equal(root.children[0].tag, 'p');
  assert.equal(root.children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(root.children[1].tag, 'ul');
  assert.equal(root.children[1].children[0].textContent, '<script>alert(1)</script>');
});

test('Leerer Body und leere Liste -> Keine Details', () => {
  const doc = makeDoc();
  const a = doc.createElement('div');
  renderMarkdown(doc, a, '  \n');
  assert.equal(a.children[0].textContent, 'Keine Details');
  const b = doc.createElement('div');
  renderUpdateNotes(doc, b, []);
  assert.equal(b.children[0].textContent, 'Keine Details');
});

test('Update-Notes: ein Abschnitt je Version in gelieferter Reihenfolge', () => {
  const doc = makeDoc();
  const root = doc.createElement('div');
  renderUpdateNotes(doc, root, [
    { version: '0.9.8', name: 'v0.9.8', body: '## Neu\n- **Foo**' },
    { version: '0.9.7', name: 'Icon', body: 'Keine Details' },
  ]);
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0].children[0].textContent, 'Version 0.9.8');
  assert.equal(root.children[1].children[0].textContent, 'Version 0.9.7 – Icon');
});
