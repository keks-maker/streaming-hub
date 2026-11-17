'use strict';

// Gate für Test-Hooks, die Netzschutz lockern (lokale Ziele): wirksam nur im isolierten Testlauf
// (STREAMING_HUB_USER_DATA) UND nur in einer nicht paketierten App. Eine ausgelieferte App ignoriert sie.
function isLocalHookAllowed(env, isPackaged, flagName) {
  return Boolean(env && env.STREAMING_HUB_USER_DATA && !isPackaged && env[flagName] === '1');
}

module.exports = { isLocalHookAllowed };
