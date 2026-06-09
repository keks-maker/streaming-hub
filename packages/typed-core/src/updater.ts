import type { UpdateInfo } from './types.js';

/**
 * Semver-Vergleich für "x.y.z"-Strings.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Extrahiert Semver-Tags aus `git ls-remote --tags`-Output.
 */
export function parseTagsFromLsRemote(output: string): string[] {
  const tags = new Set<string>();
  for (const line of output.split('\n')) {
    const m = line.match(/refs\/tags\/v?(\d+\.\d+\.\d+)/);
    if (m) tags.add(m[1]!);
  }
  return [...tags].sort(compareVersions);
}

/**
 * Erzeugt UpdateInfo aus aktueller + Remote-Tags.
 */
export function checkForUpdate(
  currentVersion: string,
  remoteTags: string[],
): UpdateInfo {
  const sorted = [...remoteTags].sort(compareVersions);
  const latest = sorted[sorted.length - 1] ?? null;
  return {
    currentVersion,
    latestVersion: latest,
    hasUpdate: latest ? compareVersions(latest, currentVersion) > 0 : false,
  };
}
