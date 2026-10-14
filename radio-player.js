// Radio-Player-Host (Konzept §2): spielt den vom RadioController aufgelösten Stream. <audio> für MP3/AAC/Ogg,
// hls.js für HLS (Pfadlogik wie tv.html), navigator.mediaSession für macOS "Läuft gerade" und Medientasten.
// Alle Zustandsentscheidungen trifft der Main; dieser Host meldet nur Ereignisse (mit der Sitzungsnummer seq).

(function () {
  const audio = document.getElementById('radio-audio');
  let hls = null;
  let seq = 0;
  let hlsLoaded = false;
  let hlsRecoverCount = 0;
  const MAX_HLS_RECOVER = 3;

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

  function teardown() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    hlsRecoverCount = 0;
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
    if (command.kind === 'hls') {
      startHls(command.url, seq);
    } else {
      audio.src = command.url;
      startAudio(seq);
    }
  }

  function setMetadata(command) {
    const session = navigator.mediaSession;
    if (!session || typeof window.MediaMetadata !== 'function') return;
    session.metadata = new window.MediaMetadata({ title: command.title || '', artist: command.artist || '', album: command.album || '' });
  }

  function setPlaybackState(value) {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = value;
  }

  audio.addEventListener('playing', function () {
    setPlaybackState('playing');
    report({ t: 'playing', seq: seq });
  });
  audio.addEventListener('ended', function () {
    report({ t: 'ended', seq: seq });
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
  });

  report({ t: 'ready' });
})();
