'use strict';

// Seite der Übernehmen-Leiste: Knopf "Anmeldung übernehmen" und "Abbrechen"; Rückmeldung des Main-Prozesses als Statuscode.
(function () {
  const doc = window.document;
  const accept = doc.getElementById('accept');
  const status = doc.getElementById('status');
  const TEXTS = {
    idle: 'Angemeldet? Dann hier übernehmen.',
    checking: 'Prüfe Anmeldung ...',
    found: 'Anmeldung gefunden – Fenster schließt.',
    none: 'Noch keine Anmeldung erkannt – bitte erst im Fenster anmelden.',
    noneZdf: 'Keine Sitzung im ZDF-Fenster gefunden. Bitte zuerst anmelden (Mein ZDF) und dann erneut übernehmen.',
  };

  function show(code) {
    status.textContent = TEXTS[code] || TEXTS.idle;
    status.dataset.state = code in TEXTS ? code : 'idle';
    accept.disabled = code === 'checking' || code === 'found';
  }

  accept.addEventListener('click', () => {
    show('checking');
    window.loginBar.accept();
  });
  doc.getElementById('cancel').addEventListener('click', () => window.loginBar.cancel());
  window.loginBar.onStatus(show);
  show('idle');
})();
