'use strict';

// Seite des PIN-Fensters: vier Ziffern, optional "PIN merken". Die PIN geht nur über window.zdfPin an den Main-Prozess.
(function () {
  const doc = window.document;
  const pin = doc.getElementById('pin');
  const ok = doc.getElementById('ok');
  const remember = doc.getElementById('remember');
  const error = doc.getElementById('error');

  function valid() {
    return /^\d{4}$/.test(pin.value);
  }

  pin.addEventListener('input', () => {
    pin.value = pin.value.replace(/\D/g, '').slice(0, 4);
    ok.disabled = !valid();
    error.textContent = '';
  });

  async function submit() {
    if (!valid()) return;
    ok.disabled = true;
    const result = await window.zdfPin.submit({ pin: pin.value, remember: remember.checked });
    if (result && result.ok === false) {
      error.textContent = 'Eingabe ungültig.';
      ok.disabled = !valid();
    }
  }

  ok.addEventListener('click', submit);
  doc.getElementById('cancel').addEventListener('click', () => window.zdfPin.cancel());
  doc.addEventListener('keydown', event => {
    if (event.key === 'Enter') submit();
    else if (event.key === 'Escape') window.zdfPin.cancel();
  });

  window.zdfPin.init().then(info => {
    if (info && typeof info.text === 'string') doc.getElementById('info').textContent = info.text;
    doc.getElementById('rememberRow').hidden = !(info && info.canRemember === true);
  });
})();
