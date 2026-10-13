'use strict';

// Isolierte Testläufe (STREAMING_HUB_USER_DATA, E2E) zeigen nie native Fehlerdialoge:
// ein modaler Dialog würde den parallel arbeitenden Nutzer stören. Statt dessen wird
// geloggt und in globalThis.__streamingHubTest.suppressedDialogs mitgezählt
// (Playwright: electronApp.evaluate). Ohne Hook: unverändertes Produktionsverhalten.
function isIsolatedTestRun(env) {
  return Boolean(env && env.STREAMING_HUB_USER_DATA);
}

function showErrorBoxGuarded({ dialog, env, logger, store }, title, content) {
  if (!isIsolatedTestRun(env)) {
    dialog.showErrorBox(title, content);
    return false;
  }
  if (store) {
    if (!Array.isArray(store.suppressedDialogs)) store.suppressedDialogs = [];
    store.suppressedDialogs.push({ title, content });
  }
  if (logger) logger.warn(`Dialog unterdrückt (Testlauf): ${title}`);
  return true;
}

module.exports = { isIsolatedTestRun, showErrorBoxGuarded };
