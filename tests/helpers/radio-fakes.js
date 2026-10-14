'use strict';

// Test-Helfer (Radio): Attrappen für BrowserWindow, Timer und Bibliothek. Dateien in tests/helpers sind KEINE Tests.

class ManualTimers {
  constructor() {
    this.items = new Map();
    this.nextId = 1;
  }

  setTimer = (fn, ms) => {
    const id = this.nextId++;
    this.items.set(id, { fn, ms });
    return id;
  };

  clearTimer = id => {
    this.items.delete(id);
  };

  /** Anzahl offener Timer (optional mit Wartezeit) */
  pending(ms) {
    return [...this.items.values()].filter(t => ms === undefined || t.ms === ms).length;
  }

  /** Führt den ältesten offenen Timer (mit Wartezeit ms, falls angegeben) aus. */
  async fire(ms) {
    const entry = [...this.items.entries()].find(([, t]) => ms === undefined || t.ms === ms);
    if (!entry) throw new Error(`kein Timer mit ${ms} ms offen (offen: ${[...this.items.values()].map(t => t.ms)})`);
    this.items.delete(entry[0]);
    await entry[1].fn();
  }
}

function createFakeWindowClass() {
  const instances = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.closed = false;
      this.listeners = {};
      this.sent = [];
      this.loaded = null;
      this.webContents = {
        send: (channel, payload) => this.sent.push({ channel, payload }),
        on: (event, handler) => {
          this.webContentsListeners = { ...(this.webContentsListeners || {}), [event]: handler };
        },
      };
      instances.push(this);
    }

    loadFile(file) {
      this.loaded = file;
      return Promise.resolve();
    }

    on(event, handler) {
      this.listeners[event] = handler;
    }

    isDestroyed() {
      return this.closed;
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.listeners.closed) this.listeners.closed();
    }

    commands() {
      return this.sent.filter(m => m.channel === 'radio-player:cmd').map(m => m.payload);
    }
  }
  return { FakeWindow, instances };
}

function createFakeLibrary({ stations = [], favorites = [], settings = {} } = {}) {
  const calls = { updateSettings: [] };
  let current = { volume: 0.8, lastStation: null, ...settings };
  return {
    calls,
    getStation: key => stations.find(s => s.sourceId === key.sourceId && s.id === key.stationId) || null,
    getFavoriteKeys: () => favorites.map(f => ({ ...f })),
    getSettings: () => ({ ...current }),
    updateSettings: patch => {
      calls.updateSettings.push(patch);
      current = { ...current, ...patch };
      return current;
    },
  };
}

module.exports = { ManualTimers, createFakeWindowClass, createFakeLibrary };
