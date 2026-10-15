// Radio-Player-Host (Konzept §2): spielt den vom RadioController aufgelösten Stream. <audio> für MP3/AAC/Ogg,
// hls.js für HLS (Pfadlogik wie tv.html), navigator.mediaSession für macOS "Läuft gerade" und Medientasten.
// Alle Zustandsentscheidungen trifft der Main; dieser Host meldet nur Ereignisse (mit der Sitzungsnummer seq).
// Datei-Modus (Podcast-Episoden, command.mode === 'file'): zusätzlich Seek, Wiedergabegeschwindigkeit, gedrosselte
// Positions-/Dauer-Meldungen (t: 'time'), Cover in der mediaSession sowie seekto/seekbackward/seekforward und setPositionState.
// Das Radioverhalten (Livestream) bleibt unverändert.

(function () {
  const audio = document.getElementById('radio-audio');
  let hls = null;
  let seq = 0;
  let hlsLoaded = false;
  let hlsRecoverCount = 0;
  const MAX_HLS_RECOVER = 3;
  const TIME_REPORT_INTERVAL_MS = 1000;
  const FILE_SEEK_ACTIONS = ['seekbackward', 'seekforward', 'seekto'];
  let fileMode = false;
  let pendingStart = 0;
  let lastTimeReport = 0;

  function report(message) {
    window.radioPlayer.report(message);
  }

  // hls.js laden: seitenlokaler Pfad (die Seite liegt im App-Stamm), Rückfall wie tv.html.
  function loadHlsJs(cb) {
    if (hlsLoaded && window.Hls) return cb(true);
    const base = window.location.href.split('?')[0];
    const dir = base.substring(0, base.lastIndexOf('/') + 1);
    const candidates = [dir + 'node_modules/hls.js/dist/hls.min.js', dir + '../../../../node_modules/hls.js/dist/hls.min.js'];
    let index = 0;
    (function tryNext() {
      if (index >= candidates.length) return cb(false);
      const script = document.createElement('script');
      script.onload = function () {
        hlsLoaded = true;
        cb(Boolean(window.Hls));
      };
      script.onerror = function () {
        script.remove();
        tryNext();
      };
      script.src = candidates[index++];
      document.head.appendChild(script);
    })();
  }

  function setFileMode(on) {
    if (fileMode === on) return;
    fileMode = on;
    if (!navigator.mediaSession) return;
    FILE_SEEK_ACTIONS.forEach(function (action) {
      try {
        navigator.mediaSession.setActionHandler(
          action,
          on
            ? function (details) {
                const message = { t: 'action', action: action };
                if (action === 'seekto') message.seekTime = details && details.seekTime;
                else if (details && details.seekOffset) message.offset = details.seekOffset;
                report(message);
              }
            : null,
        );
      } catch (_) {
        // Aktion auf dieser Plattform nicht unterstützt
      }
    });
  }

  function clampRate(value) {
    return typeof value === 'number' && isFinite(value) ? Math.min(2, Math.max(0.75, value)) : 1;
  }

  function reportTime(force) {
    if (!fileMode || audio.readyState === 0) return; // ohne geladene Metadaten ist die Position bedeutungslos (z. B. Pause-Ereignis des Teardowns)
    const now = Date.now();
    if (!force && now - lastTimeReport < TIME_REPORT_INTERVAL_MS) return;
    lastTimeReport = now;
    const message = { t: 'time', seq: seq, position: audio.currentTime || 0 };
    if (isFinite(audio.duration) && audio.duration > 0) message.duration = audio.duration;
    report(message);
    updatePositionState();
  }

  function updatePositionState() {
    const session = navigator.mediaSession;
    if (!session || typeof session.setPositionState !== 'function' || !isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      session.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.duration, Math.max(0, audio.currentTime || 0)),
      });
    } catch (_) {
      // ungültige Kombination (z. B. Position hinter der Dauer): ignorieren
    }
  }

  function teardown() {
    pendingStart = 0;
    audio.defaultPlaybackRate = 1;
    if (hls) {
      hls.destroy();
      hls = null;
    }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    hlsRecoverCount = 0;
    setFileMode(false);
  }

  function startHls(url, mySeq) {
    loadHlsJs(function (ok) {
      if (mySeq !== seq) return;
      if (ok && window.Hls.isSupported()) {
        hls = new window.Hls({ lowLatencyMode: false });
        hls.on(window.Hls.Events.ERROR, function (_event, data) {
          if (!data.fatal || mySeq !== seq) return;
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && hlsRecoverCount < MAX_HLS_RECOVER) {
            hlsRecoverCount += 1;
            hls.startLoad();
          } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && hlsRecoverCount < MAX_HLS_RECOVER) {
            hlsRecoverCount += 1;
            hls.recoverMediaError();
          } else {
            report({ t: 'error', seq: mySeq, code: 0, fatal: true, message: String(data.details || 'hls') });
          }
        });
        hls.loadSource(url);
        hls.attachMedia(audio);
      } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
        audio.src = url;
      } else {
        report({ t: 'error', seq: mySeq, code: 4, fatal: true, message: 'hls.js nicht verfügbar' });
        return;
      }
      startAudio(mySeq);
    });
  }

  function startAudio(mySeq) {
    const promise = audio.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(function (error) {
        // AbortError: durch neuen Befehl unterbrochen (kein Fehler)
        if (mySeq !== seq || (error && error.name === 'AbortError')) return;
        report({ t: 'error', seq: mySeq, code: error && error.name === 'NotSupportedError' ? 4 : 0, fatal: true, message: String(error && error.name) });
      });
    }
  }

  function play(command) {
    teardown();
    seq = command.seq;
    audio.volume = typeof command.volume === 'number' ? Math.min(1, Math.max(0, command.volume)) : 1;
    if (command.mode === 'file') {
      setFileMode(true);
      const rate = clampRate(command.rate);
      audio.defaultPlaybackRate = rate;
      audio.playbackRate = rate;
      pendingStart = typeof command.start === 'number' && command.start > 0 ? command.start : 0;
      audio.src = command.url;
      startAudio(seq);
    } else if (command.kind === 'hls') {
      startHls(command.url, seq);
    } else {
      audio.src = command.url;
      startAudio(seq);
    }
  }

  // Cover der Episode (nur http/https); Radio sendet keins
  function artworkOf(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? [{ src: url }] : [];
  }

  function setMetadata(command) {
    const session = navigator.mediaSession;
    if (!session || typeof window.MediaMetadata !== 'function') return;
    session.metadata = new window.MediaMetadata({ title: command.title || '', artist: command.artist || '', album: command.album || '', artwork: artworkOf(command.artwork) });
  }

  function setPlaybackState(value) {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = value;
  }

  audio.addEventListener('playing', function () {
    setPlaybackState('playing');
    report({ t: 'playing', seq: seq });
  });
  audio.addEventListener('ended', function () {
    reportTime(true);
    report({ t: 'ended', seq: seq });
  });
  audio.addEventListener('loadedmetadata', function () {
    if (!fileMode) return;
    if (pendingStart > 0) {
      // Fortsetzen an der gespeicherten Position; hinter dem Ende (Dauer kürzer als erwartet) von vorn
      audio.currentTime = isFinite(audio.duration) && pendingStart >= audio.duration ? 0 : pendingStart;
      pendingStart = 0;
    }
    reportTime(true);
  });
  audio.addEventListener('timeupdate', function () {
    reportTime(false);
  });
  ['durationchange', 'seeked', 'ratechange'].forEach(function (name) {
    audio.addEventListener(name, function () {
      reportTime(name !== 'ratechange');
    });
  });
  audio.addEventListener('pause', function () {
    if (!fileMode || audio.ended || audio.readyState === 0) return;
    setPlaybackState('paused');
    reportTime(true);
  });
  audio.addEventListener('error', function () {
    const error = audio.error;
    if (!audio.getAttribute('src') && !hls) return; // durch teardown ausgelöst
    report({ t: 'error', seq: seq, code: error ? error.code : 0, fatal: true, message: error && error.message ? String(error.message) : '' });
  });

  if (navigator.mediaSession) {
    ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'].forEach(function (action) {
      try {
        navigator.mediaSession.setActionHandler(action, function () {
          report({ t: 'action', action: action });
        });
      } catch (_) {
        // Aktion auf dieser Plattform nicht unterstützt
      }
    });
  }

  window.radioPlayer.onCmd(function (command) {
    if (!command || typeof command.cmd !== 'string') return;
    if (command.cmd === 'play') play(command);
    else if (command.cmd === 'halt') {
      teardown();
      setPlaybackState('paused');
    } else if (command.cmd === 'volume' && typeof command.volume === 'number') audio.volume = Math.min(1, Math.max(0, command.volume));
    else if (command.cmd === 'meta') setMetadata(command);
    else if (fileMode && command.cmd === 'pause') audio.pause();
    else if (fileMode && command.cmd === 'resume') startAudio(seq);
    else if (fileMode && command.cmd === 'seek' && typeof command.position === 'number' && command.position >= 0) {
      if (audio.readyState === 0) pendingStart = command.position;
      else audio.currentTime = command.position;
    } else if (fileMode && command.cmd === 'rate') {
      audio.defaultPlaybackRate = clampRate(command.rate);
      audio.playbackRate = clampRate(command.rate);
    }
  });

  report({ t: 'ready' });
})();
