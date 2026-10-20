'use strict';

// Nur für isolierte E2E-Läufe: ersetzt das Anbieter-Fenster durch ein festes Ergebnis (kein echter Login, kein Netz).
// STREAMING_HUB_E2E_MEDIATHEK_LOGIN = "ok" (Anmeldung gelingt mit Fake-Token) | "cancel" (Fenster geschlossen). Aktiv nur in
// einem Testlauf (siehe main.js). Die Fake-Token sind Platzhalter und laufen in einer Stunde ab.

function createE2eLoginRunner(mode, now = Date.now) {
  return {
    isBusy: () => false,
    async run(provider) {
      if (mode !== 'ok') return { ok: false, code: 'cancelled' };
      const at = now();
      return { ok: true, record: { accessToken: `e2e-access-${provider.sender}`, refreshToken: `e2e-refresh-${provider.sender}`, expiresAt: at + 3600 * 1000, since: at, state: 'ok', clientId: provider.sender === 'arte' ? 'e2e-client' : null } };
    },
  };
}

/** Ersatz für das Token-Netz der Konten (createAuthNet) im E2E-Lauf: antwortet ohne Netzverkehr mit frischen Fake-Token. */
function createE2eAuthNet() {
  const answer = async () => ({ id_token: 'e2e-id', access_token: 'e2e-access', refresh_token: 'e2e-refresh', expires_in: 3600 });
  return { postJson: answer, postForm: answer };
}

module.exports = { createE2eLoginRunner, createE2eAuthNet };
