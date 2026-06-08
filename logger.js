// v0.4.23 – Structured Logger
// Lädt in beiden Kontexten: Node.js (require) und Browser (script-Tag)
(function (global) {
  'use strict';

  const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  let currentLevel = LOG_LEVELS.info;

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function formatTimestamp() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function log(level, args) {
    if (LOG_LEVELS[level] < currentLevel) return;
    const ts = formatTimestamp();
    const prefix = '[' + ts + '] [' + level.toUpperCase() + '] [StreamingHub]';
    const fn = level === 'error' ? console.error
      : level === 'warn' ? console.warn
      : level === 'debug' ? console.debug
      : console.log;
    // Prepend prefix as first argument so formatting works
    Array.prototype.unshift.call(args, prefix);
    fn.apply(console, args);
  }

  const logger = {
    debug: function () { log('debug', arguments); },
    info: function () { log('info', arguments); },
    warn: function () { log('warn', arguments); },
    error: function () { log('error', arguments); },

    setLevel: function (lvl) {
      if (LOG_LEVELS[lvl] !== undefined) currentLevel = LOG_LEVELS[lvl];
    },

    getLevel: function () {
      const keys = Object.keys(LOG_LEVELS);
      for (let i = 0; i < keys.length; i++) {
        if (LOG_LEVELS[keys[i]] === currentLevel) return keys[i];
      }
      return 'info';
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = logger;
  } else {
    global.logger = logger;
  }
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
