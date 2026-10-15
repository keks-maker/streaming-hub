'use strict';

// Test-Helfer: minimales Fake-DOM für die Radio-Ansichten (kein jsdom im Projekt). Dateien in tests/helpers sind KEINE Tests.

class FakeNode {
  constructor(tag, doc) {
    this.tagName = tag;
    this.ownerDocument = doc;
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.style = { setProperty: () => {} };
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.value = '';
    this.id = '';
    this.title = '';
    this._text = '';
    this.innerHTML = '';
    const node = this;
    this.classList = {
      toggle(name, on) {
        const set = new Set(node.className.split(/\s+/).filter(Boolean));
        const enable = on === undefined ? !set.has(name) : on;
        if (enable) set.add(name);
        else set.delete(name);
        node.className = [...set].join(' ');
      },
      add: name => node.classList.toggle(name, true),
      remove: name => node.classList.toggle(name, false),
      contains: name => node.className.split(/\s+/).includes(name),
    };
  }
  get textContent() {
    return this._text + this.children.map(c => c.textContent).join('');
  }
  set textContent(value) {
    this.children.forEach(c => (c.parent = null));
    this.children = [];
    this._text = String(value);
  }
  append(...nodes) {
    nodes.forEach(n => this.appendChild(n));
  }
  appendChild(node) {
    node.parent = this;
    this.children.push(node);
    return node;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attrs[name] = value;
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  getAttribute(name) {
    return this.attrs[name];
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  click() {
    if (this.disabled) return;
    this.dispatch('click');
  }
  find(pred, acc = []) {
    if (pred(this)) acc.push(this);
    this.children.forEach(c => c.find && c.find(pred, acc));
    return acc;
  }
  byId(id) {
    return this.find(n => n.id === id)[0] || null;
  }
  byClass(name) {
    return this.find(n => n.classList && n.classList.contains(name));
  }
}

function makeDoc() {
  const handlers = {};
  const doc = {
    addEventListener: (type, fn) => (handlers[type] = handlers[type] || []).push(fn),
    dispatch: (type, event = {}) => (handlers[type] || []).forEach(fn => fn(event)),
    createElement: tag => new FakeNode(tag, doc),
    createTextNode: text => ({ textContent: text, nodeType: 3 }),
  };
  return doc;
}

/** Fake für window.radio: Zustand/Quellen setzbar, Aufrufe protokolliert, Listener auslösbar. */
function makeFakeRadio({ sources = [], state = { status: 'idle', station: null, volume: 0.8, nowPlaying: null, error: null, reconnecting: false } } = {}) {
  const calls = [];
  const listeners = { state: new Set(), sources: new Set() };
  const radio = {
    calls,
    sources,
    state,
    getSources: async () => radio.sources,
    getState: async () => radio.state,
    getSettings: async () => ({ pauseOnTv: true }),
    play: async key => calls.push(['play', key]),
    pause: async () => calls.push(['pause']),
    stop: async () => calls.push(['stop']),
    next: async () => calls.push(['next']),
    prev: async () => calls.push(['prev']),
    setVolume: async value => calls.push(['setVolume', value]),
    setFavorite: async (key, flag) => calls.push(['setFavorite', key, flag]),
    onState: cb => {
      listeners.state.add(cb);
      return () => listeners.state.delete(cb);
    },
    onSourcesChanged: cb => {
      listeners.sources.add(cb);
      return () => listeners.sources.delete(cb);
    },
    emitState: next => {
      radio.state = next;
      listeners.state.forEach(cb => cb(next));
    },
    emitSources: next => {
      radio.sources = next;
      listeners.sources.forEach(cb => cb(next));
    },
    listenerCount: () => listeners.state.size + listeners.sources.size,
  };
  return radio;
}

module.exports = { FakeNode, makeDoc, makeFakeRadio };
