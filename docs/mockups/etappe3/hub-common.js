/* Mockup-Steuerung (nicht Teil der App). Setzt data-Attribute auf den .frame-Elementen. */
(function () {
  'use strict';
  var STATES = [
    ['normal', 'Normal'],
    ['nofav', 'Keine Favoriten (Hinweis)'],
    ['nofav2', 'Keine Favoriten (Alternative: Button)'],
    ['norec', 'Keine Aufnahmen'],
    ['noffmpeg', 'ffmpeg fehlt'],
    ['running', 'Aufnahme läuft']
  ];
  var WIDTHS = [['1280px', '1280 px'], ['880px', '880 px (< 900)'], ['560px', '560 px (sehr schmal)']];
  var INDS = [['off', 'ohne Indikator'], ['dot', 'Punkt'], ['badge', 'Punkt + Zahl']];
  var VIEWS = [['livetv', 'LiveTV-Dashboard'], ['svc', 'Streamingdienst (P21)']];
  var st = { state: 'normal', width: '1280px', ind: 'dot', view: 'livetv', demo: 'off', all: false };

  function applyFor(root) {
    var s = root.getAttribute('data-state');
    root.querySelectorAll('[data-for]').forEach(function (el) {
      el.hidden = el.getAttribute('data-for').split(' ').indexOf(s) === -1;
    });
  }
  function setAttrs(f, s) {
    f.setAttribute('data-state', s);
    f.setAttribute('data-ind', st.ind);
    f.setAttribute('data-view', st.view);
    f.setAttribute('data-demo', st.demo);
    applyFor(f);
  }
  function render() {
    var host = document.getElementById('frames');
    var proto = document.getElementById('proto');
    host.innerHTML = '';
    var list = st.all ? STATES : [STATES.filter(function (x) { return x[0] === st.state; })[0]];
    list.forEach(function (x) {
      var wrap = document.createElement('div');
      wrap.className = 'frame-wrap';
      wrap.style.setProperty('--w', st.width);
      if (st.all) {
        var l = document.createElement('p');
        l.className = 'frame-label';
        l.textContent = x[1];
        wrap.appendChild(l);
      }
      var f = proto.querySelector('.frame').cloneNode(true);
      if (st.all) f.classList.add('compact');
      setAttrs(f, x[0]);
      wrap.appendChild(f);
      host.appendChild(wrap);
    });
    document.querySelectorAll('.mk-seg button').forEach(function (b) {
      var k = b.getAttribute('data-k'), v = b.getAttribute('data-v');
      var on = k === 'all' ? String(st.all) === v : k === 'demo' ? st.demo === v : st[k] === v;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function seg(label, key, items) {
    var h = '<div class="mk-row"><span class="mk-lbl">' + label + '</span><div class="mk-seg">';
    items.forEach(function (i) { h += '<button type="button" data-k="' + key + '" data-v="' + i[0] + '">' + i[1] + '</button>'; });
    return h + '</div></div>';
  }
  function init(title) {
    var mk = document.getElementById('mk');
    mk.innerHTML =
      '<div class="mk-row"><span class="mk-badge">Mockup – nicht die App</span><strong>' + title + '</strong><a href="index.html">Übersicht</a></div>' +
      seg('Zustand', 'state', STATES) + seg('Fensterbreite', 'width', WIDTHS) +
      seg('NavBar-Indikator', 'ind', INDS) + seg('Ansicht', 'view', VIEWS) +
      '<div class="mk-row"><span class="mk-lbl">Fokus / Hover</span><div class="mk-seg">' +
      '<button type="button" data-k="demo" data-v="on">Demo: Karte 1 fokussiert, Karte 2 Hover</button>' +
      '<button type="button" data-k="demo" data-v="off">aus (Tab-Taste und Maus selbst testen)</button></div></div>' +
      '<div class="mk-row"><span class="mk-lbl">Darstellung</span><div class="mk-seg">' +
      '<button type="button" data-k="all" data-v="false">ein Zustand</button>' +
      '<button type="button" data-k="all" data-v="true">alle Zustände untereinander</button></div></div>' +
      '<p class="mk-note">Beispieldaten, keine App-Logik. Indikator-Zeile wirkt nur im Zustand „Aufnahme läuft“. Klicks auf Karten und Werkzeuge sind ohne Funktion.</p>';
    mk.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-k]');
      if (!b) return;
      var k = b.getAttribute('data-k'), v = b.getAttribute('data-v');
      if (k === 'all') st.all = v === 'true'; else st[k] = v;
      if (k === 'view' && v === 'svc' && st.state !== 'running') st.state = 'running';
      render();
    });
    render();
  }
  window.HubMock = { init: init };
})();
