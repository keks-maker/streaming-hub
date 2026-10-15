'use strict';

// Tests: Shownotes als anklickbares, bereinigtes HTML-Modell (Main-Sanitizer, gemeinsames Schema, Renderer ohne innerHTML,
// IPC podcast:open-link und podcast:shownote-image).

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeShownotes, pickShownotes, treeToText } = require('../lib/podcast/shownotes-sanitizer.js');
const { safeUrl, cleanTree, collectImageUrls, TAGS } = require('../lib/podcast/shownotes-schema.js');
const { registerPodcastIpc } = require('../lib/podcast/ipc.js');
const { validatePodcastOpenLink, validatePodcastShownoteImage } = require('../lib/ipc-validation.js');
const { renderShownotes } = require('../podcast-shownotes-view.js');
const { FakeNode, makeDoc } = require('./helpers/fake-dom.js');

const tagsOf = tree => {
  const found = new Set();
  const visit = list => {
    for (const node of list) {
      if (node && typeof node === 'object') {
        found.add(node.t);
        if (node.c) visit(node.c);
      }
    }
  };
  visit(tree);
  return found;
};

/** Jeder Baum muss der Allowlist genügen: nur bekannte Tags, Adressen sicher, keine fremden Attribute. */
function assertSafeTree(tree, label = '') {
  const visit = (list, depth) => {
    assert.ok(depth <= 32, `${label}: Tiefe`);
    for (const node of list) {
      if (typeof node === 'string') continue;
      assert.ok(TAGS.has(node.t), `${label}: Tag ${node.t}`);
      for (const [name, value] of Object.entries(node.a || {})) {
        assert.ok(['href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan'].includes(name), `${label}: Attribut ${name}`);
        if (name === 'href') assert.ok(/^(https?:\/\/|mailto:)/.test(value) && !/^https?:\/\/[^/]*@/.test(value), `${label}: href ${value}`);
        if (name === 'src') assert.ok(/^https?:\/\//.test(value), `${label}: src ${value}`);
      }
      if (node.c) visit(node.c, depth + 1);
    }
  };
  visit(tree, 0);
}

test('Sanitizer: alle erlaubten Elemente bleiben erhalten (b/i/strike werden kanonisch)', () => {
  const html = `<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><h5>e</h5><h6>f</h6><div><span>s</span></div><p>p<br>q</p><ul><li>u</li></ul><ol><li>o</li></ol>
    <dl><dt>t</dt><dd>d</dd></dl><blockquote>q</blockquote><pre>pre</pre><code>code</code><hr><strong>x</strong><b>x</b><em>x</em><i>x</i><u>x</u><s>x</s><strike>x</strike><del>x</del><ins>x</ins>
    <sub>x</sub><sup>x</sup><small>x</small><mark>x</mark><table><caption>c</caption><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td rowspan="3">d</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>
    <figure><img src="https://e.test/a.png" alt="A" title="T" width="10" height="20"><figcaption>cap</figcaption></figure><a href="https://e.test/" title="L">l</a>`;
  const tree = sanitizeShownotes(html);
  const expected = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p', 'br', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code', 'hr', 'strong', 'em', 'u', 's', 'del', 'ins', 'sub', 'sup', 'small', 'mark', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'figure', 'img', 'figcaption', 'a'];
  assert.deepEqual([...tagsOf(tree)].sort(), expected.sort());
  assertSafeTree(tree);
  const img = JSON.stringify(tree).match(/\{"t":"img","a":(\{[^}]*\})\}/);
  assert.deepEqual(JSON.parse(img[1]), { src: 'https://e.test/a.png', alt: 'A', title: 'T', width: 10, height: 20 });
  assert.ok(JSON.stringify(tree).includes('"colspan":2') && JSON.stringify(tree).includes('"rowspan":3'));
});

test('Sanitizer: Attribute außerhalb der Allowlist entfallen, colspan/rowspan nur numerisch ≤ 20', () => {
  const tree = sanitizeShownotes('<p class="x" id="y" style="color:red" onclick="z()">a</p><table><tr><td colspan="99">1</td><td colspan="x">2</td><td colspan="3" rowspan="20">3</td></tr></table><a href="https://e.test/" onclick="x" style="a" target="_blank" rel="x">l</a><img src="https://e.test/i.png" srcset="evil.png 2x" onerror="x" width="abc" height="5">');
  const json = JSON.stringify(tree);
  assert.ok(!/class|"id"|style|onclick|onerror|srcset|target|"rel"/.test(json), json);
  assert.ok(!json.includes('"colspan":99') && !json.includes('"colspan":"x"'), json);
  assert.ok(json.includes('"colspan":3,"rowspan":20') || json.includes('"rowspan":20,"colspan":3'), json);
  assert.ok(!json.includes('"width"') && json.includes('"height":5'));
});

test('Sanitizer: gefährliche Elemente samt Inhalt entfernt, unbekannte Tags behalten den Inhalt', () => {
  const tree = sanitizeShownotes('<custom-x>bleibt</custom-x><font color="red">auch</font><script>alert(1)</script><style>p{}</style><iframe src="https://e.test"><p>innen</p></iframe><object data="x">o</object><embed src="x"><audio src="x">a</audio><video>v</video><form action="https://evil.test"><input name="p">f</form><svg><script>x</script><g>g</g></svg><math><mi>m</mi></math><link rel="stylesheet" href="x"><meta http-equiv="refresh" content="0;url=x"><base href="https://evil.test/">ende');
  const json = JSON.stringify(tree);
  assert.ok(!/alert|innen|"o"|"v"|evil|"g"|"m"|stylesheet|refresh|p\{\}/.test(json), json);
  assert.equal(treeToText(tree, 100), 'bleibtauchende');
  assertSafeTree(tree);
});

test('Sanitizer: XSS-Korpus liefert nur sichere Bäume (href/src ohne javascript:, data:, vbscript:, file:, relative, //evil, userinfo)', () => {
  const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'java&#09;script:alert(1)', ' javascript:alert(1)', '&#106;avascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd', '//evil.test/x', '/relativ', 'relativ.html', 'http://user:pw@host.test/', 'https://user@host.test/', 'ftp://host.test/', 'http:///x', 'blob:https://e.test/1', 'jar:https://e.test/!/', 'tel:123'];
  for (const url of bad) {
    const tree = sanitizeShownotes(`<a href="${url}">l</a><img src="${url}" alt="alt"><a href='${url}'>m</a>`);
    assertSafeTree(tree, url);
    assert.ok(!tagsOf(tree).has('img'), `Bild mit ${url}`);
    assert.ok(!tagsOf(tree).has('a'), `Link mit ${url}`);
  }
  const corpus = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>', '<iframe src="javascript:alert(1)"></iframe><iframe><iframe src=x>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<<script>script>alert(1)<</script>/script>', '<scr<script>ipt>alert(1)</scr</script>ipt>', '<a href="x" onmouseover=alert(1)>x', '<a href=javascript&colon;alert(1)>x</a>', '<a href="&#x6A;avascript:alert(1)">x</a>',
    '<style>@import "javascript:alert(1)"</style>', '<base href="javascript:alert(1)//">', '<form action="javascript:alert(1)"><button>x</button></form>', '<body onload=alert(1)>', '<div style="background:url(javascript:alert(1))">x</div>',
    '<!--[if IE]><script>alert(1)</script><![endif]-->', '<![CDATA[<script>alert(1)</script>]]>', '<a href="http://a.test/" href="javascript:alert(1)">x</a>', '<img src="https://e.test/a.png" src="javascript:x">', '<a\nhref\n=\n"javascript:alert(1)"\n>x</a>', '<a href="javascript:alert(1)',
    '<p><b><i>unbalanciert', '</div></p></b>', '<div><p><span>', '<table><td><table><td>', '&lt;script&gt;alert(1)&lt;/script&gt;', '&#60;script&#62;alert(1)&#60;/script&#62;', '&amp;lt;script&amp;gt;', '&#x3C;img src=x onerror=alert(1)&#x3E;', '&#0;&#xD800;&#99999999;&bogus;&',
    '<img src="https://e.test/a.png" alt="x" onerror="alert(1)">', '<a href="mailto:x@y.test?body=<script>">m</a>',
  ];
  for (const input of corpus) {
    for (const wrap of [input, `<![CDATA[${input}]]>`]) {
      const tree = sanitizeShownotes(wrap);
      assertSafeTree(tree, input);
      assert.ok(!/<|alert\(|onerror|onload/i.test(treeToText(tree, 1000)) || /^(&|<<|<scr|<!)|&lt;|&#|&amp;/.test(input) || input.includes('CDATA'), `${input} -> ${treeToText(tree, 100)}`);
    }
  }
});

test('Sanitizer: Escapes im Text werden nur Text (nie wieder Markup)', () => {
  const tree = sanitizeShownotes('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp;lt;b&amp;gt;</p>');
  assert.deepEqual(tree, [{ t: 'p', c: ['<script>alert(1)</script> &lt;b&gt;'] }]);
  assert.deepEqual(sanitizeShownotes('&lt;p&gt;Hallo &lt;b&gt;Welt&lt;/b&gt;&lt;/p&gt;'), [{ t: 'p', c: ['Hallo ', { t: 'strong', c: ['Welt'] }] }]);
});

test('Sanitizer: Links nur http/https/mailto; Schema case-insensitiv; Steuerzeichen/Tabs im Schema; Auto-Link im Klartext', () => {
  const tree = sanitizeShownotes('<a href="HTTPS://Example.org/a b">x</a> <a href="mailto:a@b.test">m</a> <a href="  http://e.test/ ">y</a>');
  assert.deepEqual(JSON.stringify(tree).match(/"href":"[^"]+"/g), ['"href":"https://example.org/a%20b"', '"href":"mailto:a@b.test"', '"href":"http://e.test/"']);
  const plain = sanitizeShownotes('Zeile eins https://a.test/x?y=1, und (http://b.test/z).\nZeile zwei\n\nNeuer Absatz javascript:alert(1) ftp://c.test');
  assert.equal(plain.length, 2);
  assert.equal(plain[0].t, 'p');
  assert.deepEqual(plain[0].c.filter(n => typeof n === 'object' && n.t === 'a').map(n => n.a.href), ['https://a.test/x?y=1', 'http://b.test/z']);
  assert.ok(plain[0].c.some(n => n.t === 'br'));
  assert.deepEqual(plain[1].c, ['Neuer Absatz javascript:alert(1) ftp://c.test']);
});

test('Sanitizer: kaputtes HTML, implizites Schließen (p, li, td), Tiefe ≤ 30, Elemente ≤ 5000, Kommentare', () => {
  assert.deepEqual(sanitizeShownotes('<p>a<p>b<ul><li>1<li>2</ul>'), [{ t: 'p', c: ['a'] }, { t: 'p', c: ['b'] }, { t: 'ul', c: [{ t: 'li', c: ['1'] }, { t: 'li', c: ['2'] }] }]);
  assert.deepEqual(sanitizeShownotes('<table><tr><td>1<td>2<tr><td>3</table>'), [{ t: 'table', c: [{ t: 'tr', c: [{ t: 'td', c: ['1'] }, { t: 'td', c: ['2'] }] }, { t: 'tr', c: [{ t: 'td', c: ['3'] }] }] }]);
  assert.deepEqual(sanitizeShownotes('a<!-- <b>x</b> -->b<!-- offen <b>c</b>'), ['ab']);
  const deep = sanitizeShownotes('<div>'.repeat(100) + 'tief' + '</div>'.repeat(100));
  let depth = 0;
  for (let node = deep[0]; node && typeof node === 'object'; node = node.c && node.c[0]) depth += 1;
  assert.ok(depth <= 31, String(depth));
  assert.ok(JSON.stringify(deep).includes('tief'));
  const many = sanitizeShownotes('<b>x</b>'.repeat(20000));
  const count = JSON.stringify(many).split('"t":').length - 1;
  assert.ok(count <= 5000, String(count));
  assert.deepEqual(sanitizeShownotes(''), []);
  assert.deepEqual(sanitizeShownotes(null), []);
  assert.deepEqual(sanitizeShownotes('   '), []);
});

test('Sanitizer: pickShownotes wählt das reichhaltigste Feld, ignoriert leere', () => {
  const rich = '<p>Viel Text mit <a href="https://a.test/">Link</a> und noch mehr Text darum herum.</p>';
  assert.equal(pickShownotes(['kurz', rich, null])[0].t, 'p');
  assert.deepEqual(pickShownotes([null, '', '  ']), []);
  assert.deepEqual(pickShownotes([null, 'nur das']), [{ t: 'p', c: ['nur das'] }]);
});

test('ReDoS: Angriffsmuster (1 und 5 MB) laufen in unter 1 s und liefern sichere Bäume', () => {
  const patterns = ['<a href="x" ', '<div>', '<!--', '<table>', '&', '<', '<a href=\'', '<p><b><i>', '<script>', '<svg>', '<td>', '</', '<a ', '&#', '<![CDATA[', '<img src="https://e.test/a.png" '];
  for (const pattern of patterns) {
    for (const mb of [1, 5]) {
      const input = pattern.repeat(Math.ceil((mb * 1024 * 1024) / pattern.length));
      const start = process.hrtime.bigint();
      const tree = sanitizeShownotes(input);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 1000, `${pattern} ${mb} MB: ${ms.toFixed(0)} ms`);
      assertSafeTree(tree, pattern);
      treeToText(tree, 600);
    }
  }
  const start = process.hrtime.bigint();
  sanitizeShownotes(`<![CDATA[${'<a href="x" '.repeat(100000)}]]>`);
  assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 1000);
});

test('safeUrl: Grenzen, userinfo, Länge, Bilder nur http/https', () => {
  assert.equal(safeUrl('https://e.test/a'), 'https://e.test/a');
  assert.equal(safeUrl('mailto:a@b.test', 'link'), 'mailto:a@b.test');
  assert.equal(safeUrl('mailto:a@b.test', 'image'), null);
  assert.equal(safeUrl(`https://e.test/${'a'.repeat(2100)}`), null);
  for (const bad of [null, undefined, 5, {}, '', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'java\nscript:1', 'https://u:p@e.test/', 'https:e.test', 'https://', 'http://e.test\\@evil.test', 'https://e.test/a\u0001b', 'x://e.test']) {
    assert.equal(safeUrl(bad), null, String(bad));
  }
});

test('cleanTree: prüft einen fremden Baum erneut (Cache-Datei/IPC nicht vertrauenswürdig)', () => {
  const evil = [
    { t: 'script', c: ['alert(1)'] }, { t: 'a', a: { href: 'javascript:alert(1)', onclick: 'x' }, c: ['link'] }, { t: 'img', a: { src: 'data:image/png;base64,AA', alt: 'alt' } },
    { t: 'p', a: { style: 'x', class: 'y' }, c: [{ t: 'b', c: ['fett'] }, 'text\u202e'] }, { t: 'img', a: { src: 'https://e.test/i.png', onerror: 'x' } }, 7, null, [], { t: 5 },
  ];
  const clean = cleanTree(evil);
  assert.deepEqual(clean, [
    'alert(1)', 'link', 'alt',
    { t: 'p', c: [{ t: 'strong', c: ['fett'] }, 'text'] },
    { t: 'img', a: { src: 'https://e.test/i.png' } },
  ]);
  assert.deepEqual(cleanTree('x'), []);
  let deep = 'x';
  for (let i = 0; i < 20000; i += 1) deep = { t: 'div', c: [deep] };
  assert.doesNotThrow(() => cleanTree([deep]));
  assert.deepEqual(collectImageUrls([{ t: 'img', a: { src: 'https://e.test/1.png' } }, { t: 'p', c: [{ t: 'img', a: { src: 'https://e.test/2.png' } }, { t: 'img', a: { src: 'https://e.test/1.png' } }] }], 20), ['https://e.test/1.png', 'https://e.test/2.png']);
  assert.equal(collectImageUrls(Array.from({ length: 50 }, (_, i) => ({ t: 'img', a: { src: `https://e.test/${i}.png` } })), 20).length, 20);
});

// ── Renderer ──

function renderDoc() {
  const doc = makeDoc();
  doc.createDocumentFragment = () => new FakeNode('#fragment', doc);
  const create = doc.createElement;
  doc.createElement = tag => {
    const node = create(tag);
    Object.defineProperty(node, 'innerHTML', { get: () => '', set: () => {
        assert.fail('innerHTML darf nie gesetzt werden');
      },
    });
    return node;
  };
  doc.createTextNode = text => ({ nodeType: 3, textContent: String(text), children: [], find: () => [] });
  return doc;
}

const all = (node, pred = () => true, acc = []) => {
  if (pred(node)) acc.push(node);
  for (const child of node.children || []) all(child, pred, acc);
  return acc;
};
const flush = () => new Promise(resolve => setTimeout(resolve, 5));

test('Renderer: Baum -> DOM nur mit createElement; Link-Klick wird abgefangen und an den Main gegeben', () => {
  const doc = renderDoc();
  const opened = [];
  const tree = sanitizeShownotes('<h2>Titel</h2><p>Text <a href="https://e.test/x" title="Hinweis">Link</a> und <a href="javascript:alert(1)">böse</a></p><ul><li>eins</li></ul><table><tr><td colspan="2">z</td></tr></table><pre>code</pre>');
  const view = renderShownotes(doc, tree, { openLink: url => opened.push(url), loadImages: false });
  const tags = all(view.element, n => n.tagName).map(n => n.tagName);
  for (const tag of ['h2', 'p', 'a', 'ul', 'li', 'table', 'td', 'pre']) assert.ok(tags.includes(tag), tag);
  const anchors = all(view.element, n => n.tagName === 'a');
  assert.equal(anchors.length, 1, 'javascript:-Link wurde entfernt');
  const [link] = anchors;
  assert.equal(link.attrs.href, 'https://e.test/x');
  assert.equal(link.attrs.rel, 'noopener noreferrer');
  assert.equal(link.attrs.target, undefined);
  assert.equal(link.title, 'Hinweis\nhttps://e.test/x');
  let prevented = 0;
  link.dispatch('click', { preventDefault: () => (prevented += 1), stopPropagation: () => {} });
  assert.equal(prevented, 1);
  assert.deepEqual(opened, ['https://e.test/x']);
  link.dispatch('auxclick', { preventDefault: () => (prevented += 1) });
  assert.equal(prevented, 2);
  assert.equal(all(view.element, n => n.tagName === 'td')[0].attrs.colspan, '2');
  assert.ok(all(view.element, n => n.tagName === 'table').length === 1 && all(view.element, n => n.className === 'podcast-notes-table-wrap').length === 1, 'Tabelle scrollbar verpackt');
  view.dispose();
});

test('Renderer: prüft den Baum erneut (fremde Tags/Adressen erreichen das DOM nie)', () => {
  const doc = renderDoc();
  const view = renderShownotes(doc, [{ t: 'script', c: ['alert(1)'] }, { t: 'a', a: { href: 'javascript:alert(1)' }, c: ['x'] }, { t: 'img', a: { src: 'javascript:alert(1)', alt: 'a' } }, { t: 'iframe', a: { src: 'https://e.test/' } }], { loadImages: true, getImage: async () => ({ ok: false }) });
  const tags = all(view.element, n => n.tagName && n !== view.element).map(n => n.tagName);
  assert.deepEqual(tags, []);
  assert.equal(view.imageCount, 0);
});

test('Renderer: Bilder laden über getImage (max. 3 parallel, max. 20), Platzhalter bei Fehler, data:image-Prüfung', async () => {
  const doc = renderDoc();
  const urls = Array.from({ length: 25 }, (_, i) => `https://e.test/${i}.png`);
  const tree = sanitizeShownotes(urls.map((url, i) => `<img src="${url}" alt="Bild ${i}" width="10" height="5">`).join(''));
  let running = 0;
  let peak = 0;
  const requested = [];
  const getImage = async url => {
    requested.push(url);
    running += 1;
    peak = Math.max(peak, running);
    await flush();
    running -= 1;
    if (url.endsWith('/3.png')) return { ok: false };
    if (url.endsWith('/4.png')) return { ok: true, dataUrl: 'javascript:alert(1)' };
    return { ok: true, dataUrl: 'data:image/png;base64,AAAA' };
  };
  const view = renderShownotes(doc, tree, { loadImages: true, getImage });
  assert.equal(view.imageCount, 25);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(requested.length, 20, 'höchstens 20 Bilder');
  assert.ok(peak <= 3 && peak >= 2, `parallel ${peak}`);
  const imgs = all(view.element, n => n.tagName === 'img');
  assert.equal(imgs.length, 18, '20 abgerufen, 2 Fehler');
  assert.ok(imgs.every(img => img.src === 'data:image/png;base64,AAAA' && img.alt.startsWith('Bild ')));
  const holders = all(view.element, n => typeof n.className === 'string' && n.className.includes('podcast-notes-img'));
  assert.equal(holders.filter(h => h.className.includes('is-error')).length, 2);
  assert.equal(holders.filter(h => h.className.includes('is-off')).length, 5, 'ab dem 21. Bild kein Abruf');
});

test('Renderer: „Bilder in Shownotes laden“ aus: kein Abruf, Alt-Text mit Hinweis; dispose bricht Warteschlange ab', async () => {
  const doc = renderDoc();
  const calls = [];
  const tree = sanitizeShownotes('<p><img src="https://e.test/a.png" alt="Beschreibung"></p>');
  const off = renderShownotes(doc, tree, { loadImages: false, getImage: async url => calls.push(url) });
  await flush();
  assert.deepEqual(calls, []);
  assert.equal(all(off.element, n => n.className === 'podcast-notes-img-alt')[0].textContent, 'Beschreibung');
  assert.ok(all(off.element, n => n.className && n.className.includes('podcast-notes-images-off')).length === 1);
  const many = sanitizeShownotes(Array.from({ length: 10 }, (_, i) => `<img src="https://e.test/${i}.png">`).join(''));
  const view = renderShownotes(doc, many, { loadImages: true, getImage: async url => { calls.push(url); await flush(); return { ok: false }; } });
  view.dispose();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(calls.length <= 3, String(calls.length));
});

// ── IPC ──

function setupShownoteIpc({ tree, settings = { get: () => ({ loadShownoteImages: true }) }, subscribed = true } = {}) {
  const handlers = new Map();
  const main = { id: 'main' };
  const library = {
    getSubscription: id => (subscribed && id === 'p1' ? { id, title: 'Show' } : null),
    getSubscriptions: () => [],
    getCatalog: () => [],
    getCachedFeed: () => ({ channel: null, episodes: [] }),
    getEpisodeDetails: (podcastId, episodeId) => (podcastId === 'p1' && episodeId === 'e1' ? { notes: '', notesTree: tree, chapters: [], chaptersUrl: null } : null),
  };
  const opened = [];
  const loads = [];
  registerPodcastIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    library,
    refresher: {},
    search: {},
    settings,
    shownoteImageLoader: { load: async url => { loads.push(url); return { ok: true, dataUrl: 'data:image/png;base64,AAAA' }; } },
    openExternal: async url => { opened.push(url); },
    requireMainRenderer: event => {
      if (event.sender !== main) throw new Error('nicht autorisiert');
    },
    sendToMain: () => {},
  });
  const call = (channel, ...args) => handlers.get(channel)({ sender: main }, ...args);
  return { handlers, call, opened, loads, main };
}

test('IPC open-link: nur Hauptfenster, nur http/https/mailto ohne userinfo, Länge ≤ 2048, genau ein String', async () => {
  const { handlers, call, opened } = setupShownoteIpc({ tree: [] });
  assert.throws(() => handlers.get('podcast:open-link')({ sender: { id: 'webview' } }, 'https://e.test/'), /nicht autorisiert/);
  assert.deepEqual(await call('podcast:open-link', 'https://e.test/a?b=1'), { ok: true });
  assert.deepEqual(await call('podcast:open-link', 'mailto:a@b.test'), { ok: true });
  assert.deepEqual(opened, ['https://e.test/a?b=1', 'mailto:a@b.test']);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x', '//evil.test', 'relativ', 'https://u:p@e.test/', `https://e.test/${'a'.repeat(2100)}`, '', null, undefined, 5, { url: 'https://e.test/' }, ['https://e.test/']]) {
    await assert.rejects(Promise.resolve().then(() => call('podcast:open-link', bad)), /ungültig/, String(bad));
  }
  assert.equal(opened.length, 2);
  assert.throws(() => validatePodcastOpenLink('java\tscript:alert(1)'));
});

test('IPC open-link: Fehler des Betriebssystems werden zu { ok: false }, ohne Open-Pfad ebenfalls', async () => {
  const handlers = new Map();
  registerPodcastIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, library: { getSubscription: () => null, getSubscriptions: () => [], getCatalog: () => [], getCachedFeed: () => ({ episodes: [] }) }, refresher: {}, search: {}, openExternal: async () => { throw new Error('boom'); }, requireMainRenderer: () => {}, sendToMain: () => {} });
  assert.deepEqual(await handlers.get('podcast:open-link')({}, 'https://e.test/'), { ok: false });
  const none = new Map();
  registerPodcastIpc({ ipcMain: { handle: (c, fn) => none.set(c, fn) }, library: { getSubscription: () => null, getSubscriptions: () => [], getCatalog: () => [], getCachedFeed: () => ({ episodes: [] }) }, refresher: {}, search: {}, requireMainRenderer: () => {}, sendToMain: () => {} });
  assert.deepEqual(await none.get('podcast:open-link')({}, 'https://e.test/'), { ok: false });
});

test('IPC shownote-image: nur Adressen aus dem Baum der Episode (max. 20), Absender, Schema, Einstellung', async () => {
  const images = Array.from({ length: 25 }, (_, i) => ({ t: 'img', a: { src: `https://img.test/${i}.png` } }));
  const { handlers, call, loads } = setupShownoteIpc({ tree: images });
  assert.throws(() => handlers.get('podcast:shownote-image')({ sender: { id: 'webview' } }, { podcastId: 'p1', episodeId: 'e1', url: 'https://img.test/0.png' }), /nicht autorisiert/);
  assert.deepEqual(await call('podcast:shownote-image', { podcastId: 'p1', episodeId: 'e1', url: 'https://img.test/0.png' }), { ok: true, dataUrl: 'data:image/png;base64,AAAA' });
  assert.deepEqual(await call('podcast:shownote-image', { podcastId: 'p1', episodeId: 'e1', url: 'https://img.test/19.png' }), { ok: true, dataUrl: 'data:image/png;base64,AAAA' });
  assert.deepEqual(await call('podcast:shownote-image', { podcastId: 'p1', episodeId: 'e1', url: 'https://img.test/20.png' }), { ok: false }, 'ab dem 21. Bild');
  assert.deepEqual(await call('podcast:shownote-image', { podcastId: 'p1', episodeId: 'e1', url: 'https://fremd.test/x.png' }), { ok: false }, 'nicht in den Shownotes');
  assert.deepEqual(await call('podcast:shownote-image', { podcastId: 'p1', episodeId: 'andere', url: 'https://img.test/0.png' }), { ok: false });
  assert.deepEqual(loads, ['https://img.test/0.png', 'https://img.test/19.png'], 'nur erlaubte Adressen lösen einen Abruf aus');
  for (const bad of [null, 'x', {}, { podcastId: 'p1', episodeId: 'e1' }, { podcastId: 'p1', episodeId: 'e1', url: 'javascript:alert(1)' }, { podcastId: 'p1', episodeId: 'e1', url: 'data:image/png;base64,AA' }, { podcastId: 'p1', episodeId: 'e1', url: 'https://img.test/0.png', extra: 1 }, { podcastId: 'a|b', episodeId: 'e1', url: 'https://img.test/0.png' }]) {
    await assert.rejects(Promise.resolve().then(() => call('podcast:shownote-image', bad)), undefined, JSON.stringify(bad));
  }
  await assert.rejects(call('podcast:shownote-image', { podcastId: 'unbekannt', episodeId: 'e1', url: 'https://img.test/0.png' }), /Abo nicht gefunden/);
  assert.throws(() => validatePodcastShownoteImage({ podcastId: 'p1', episodeId: 'e1', url: 'mailto:a@b.test' }));
  const off = setupShownoteIpc({ tree: images, settings: { get: () => ({ loadShownoteImages: false }) } });
  assert.deepEqual(await off.call('podcast:shownote-image', { podcastId: 'p1', episodeId: 'e1', url: 'https://img.test/0.png' }), { ok: false });
  assert.deepEqual(off.loads, [], 'Einstellung aus: kein Abruf');
});

test('IPC episode-details liefert den Baum erneut bereinigt (Cache-Datei nicht vertrauenswürdig ist Sache der Bibliothek)', async () => {
  const { call } = setupShownoteIpc({ tree: [{ t: 'p', c: ['x'] }] });
  assert.deepEqual((await call('podcast:episode-details', { podcastId: 'p1', episodeId: 'e1' })).notesTree, [{ t: 'p', c: ['x'] }]);
});
