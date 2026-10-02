// lib/bundle-install.js — Sichere macOS-Bundle-Installation für den In-App-Updater
//
// Root-Cause des S-Klasse-Bugs (Karte t_ea243f43, Update 0.5.18→0.5.23):
// fs.cpSync(...) rekonstruiert relativ aufgelöste Bundle-Symlinks (z. B.
// "Electron Framework.framework/Versions/Current -> A") als ABSOLUTE Symlinks
// auf den Quellpfad im temporären Update-Verzeichnis — mit dereference:true
// sogar dateisymlink-erhaltend absolut. Nach dem Abschluss löscht der Updater
// das Temp-Verzeichnis, die Symlinks zeigen ins Leere, dyld findet das
// Electron Framework nicht mehr → Start-SIGABRT.
//
// Bestätigt empirisch (Node 22.22.3): cpSync mit dereference:true UND
// dereference:false erzeugen beide absolute Symlinks auf die Quelle.
//
// Dieses Modul stellt deshalb bereit:
//  - copyBundleTree: eigene rekursive Kopie, die Symlinks VERBATIM erhält
//    (relatives Ziel bleibt relativ — Standard-MacOS-Bundle-Layout bleibt intakt)
//  - verifyBundleIntegrity: Post-Install-Gate (Symlink-Kontainment, Auflösbarkeit,
//    Framework-Präsenz, optional codesign --verify --deep --strict)
//  - recoverStaleUpdateDirs: Selbstheilung nach abgebrochenen Update-Läufen
//    (stale Rollbacks werden zurückgeholt, statt sie still zu löschen)
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Rekursiver Bundle-Copy, der Symlinks verbatim erhält.
 * - Relativer Symlink → wird als identisch relativer Symlink neu erzeugt.
 * - Absoluter Symlink, der INNERHALB des Quellbaums liegt → wird relativ
 *   umgeschrieben (bleibt dadurch im Zielbaum auflösbar).
 * - Absoluter Symlink nach AUSSERHALB des Quellbaums → Fehler (fail-fast am
 *   Staging-Punkt; die echte Installation bleibt unberührt).
 * Datei- und Verzeichnisrechte werden übertragen (Modus + X-Bits).
 */
function copyBundleTree(src, dest) {
  const srcStat = fs.lstatSync(src);
  if (srcStat.isSymbolicLink()) {
    throw new Error(`copyBundleTree: Quelle selbst ist ein Symlink (${src}) — Zielpfad direkt verwenden`);
  }
  if (!srcStat.isDirectory()) throw new Error(`copyBundleTree: Quelle ist kein Verzeichnis (${src})`);
  fs.mkdirSync(dest, { recursive: true });
  fs.chmodSync(dest, srcStat.mode);

  function walk(from, to) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(fromPath);
        if (!path.isAbsolute(target)) {
          // Relativer Symlink: verbatim übernehmen — da der Baum 1:1 gespiegelt
          // wird, löst dasselbe relative Ziel im Zielbaum auf dasselbe Element auf
          // (Standard-MacOS-Bundle-Layout bleibt exakt erhalten).
          fs.symlinkSync(target, toPath);
          continue;
        }
        const resolved = target;
        if (isInside(src, resolved)) {
          // Absoluter Selbstbezug der Quelle → relativ umschreiben, aber auf
          // das GESPIEGELTE Ziel im Zielbaum (nicht auf die Quelle!).
          const mirrored = path.join(dest, path.relative(src, resolved));
          fs.symlinkSync(path.relative(path.dirname(toPath), mirrored), toPath);
        } else {
          throw new Error(
            `copyBundleTree: absoluter Symlink außerhalb des Quellbaums abgelehnt: ${fromPath} -> ${target}`
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        fs.mkdirSync(toPath, { recursive: true });
        fs.chmodSync(toPath, fs.statSync(fromPath).mode);
        walk(fromPath, toPath);
        continue;
      }
      if (entry.isFile()) {
        fs.copyFileSync(fromPath, toPath);
        fs.chmodSync(toPath, fs.statSync(fromPath).mode);
        continue;
      }
      // Andere Typen (FIFO, Socket …) haben in einem .app-Bundle nichts verloren.
      throw new Error(`copyBundleTree: unerwarteter Dateityp ${entry.name} (${fromPath})`);
    }
  }
  walk(src, dest);
  return dest;
}

/**
 * Sammelt alle Symlinks unterhalb von root.
 * Rückgabe: Array von { link, target } (target = raw readlink).
 */
function listSymlinks(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        out.push({ link: full, target: fs.readlinkSync(full) });
      } else if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return out;
}

/**
 * Liest CFBundleExecutable aus der Info.plist (regex, ohne Zusatz-Abhängigkeit).
 */
function readBundleExecutable(bundle) {
  try {
    const plist = fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf-8');
    const match = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
    return match ? match[1].trim() : null;
  } catch (_) {
    return null;
  }
}

/**
 * Post-Install-Integritäts-Gate (bindend, siehe Karte t_ea243f43 Schritt 3).
 *
 * checks (alle aktivierbar, default: alle außer codesign):
 *  - symlinks:  kein Symlink im Bundle zeigt per ABSOLUTE Zielangabe aus dem
 *               Bundle heraus — Ausnahme: explizit freigegebene Ziele
 *               (Resources/app -> Support-Verzeichnis, bewusstes Design).
 *               Relative Symlinks müssen innerhalb des Bundles auflösbar sein.
 *  - resolvable: jeder relative Symlink auflöst (keine toten Links).
 *  - frameworks: je *.framework unter Contents/Frameworks (und Contents/
 *               Frameworks/*.framework/Versions/*) existiert Versions/Current
 *               und löst auf; Haupt-Binary existiert. Optional otool-basierter
 *               dyld-Trockentest (prüfung aller @rpath-Abhängigkeiten), wenn
 *               otool verfügbar ist.
 *  - codesign:  `codesign --verify --deep --strict` (nur macOS).
 *
 * Rückgabe: { ok: true } oder { ok: false, errors: [string] }.
 */
function verifyBundleIntegrity(bundle, options = {}) {
  const opts = {
    symlinks: true,
    resolvable: true,
    frameworks: true,
    codesign: false,
    otool: false,
    allowedAbsoluteTargets: [],
    ...options,
  };
  const errors = [];

  if (opts.symlinks || opts.resolvable) {
    for (const { link, target } of listSymlinks(bundle)) {
      if (path.isAbsolute(target)) {
        const allowed = opts.allowedAbsoluteTargets.some(allowed =>
          path.resolve(target) === path.resolve(allowed)
        );
        if (!allowed) {
          errors.push(`absoluter Symlink außerhalb des Bundle-Designs: ${link} -> ${target}`);
        }
        continue;
      }
      const resolved = path.resolve(path.dirname(link), target);
      if (!isInside(bundle, resolved)) {
        errors.push(`relativer Symlink verlässt das Bundle: ${link} -> ${target}`);
        continue;
      }
      if (opts.resolvable && !fs.existsSync(resolved)) {
        errors.push(`toter (nicht auflösbarer) Symlink: ${link} -> ${target}`);
      }
    }
  }

  if (opts.frameworks) {
    const executable = readBundleExecutable(bundle);
    const macosDir = path.join(bundle, 'Contents', 'MacOS');
    if (executable) {
      if (!fs.existsSync(path.join(macosDir, executable))) {
        errors.push(`Haupt-Binary fehlt (CFBundleExecutable=${executable})`);
      }
    }
    const frameworksRoot = path.join(bundle, 'Contents', 'Frameworks');
    if (fs.existsSync(frameworksRoot)) {
      for (const entry of fs.readdirSync(frameworksRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith('.framework')) continue;
        const fw = path.join(frameworksRoot, entry.name);
        const versionsDir = path.join(fw, 'Versions');
        let current = null;
        try { current = fs.readlinkSync(path.join(versionsDir, 'Current')); } catch (_) {}
        const currentResolved = current
          ? path.resolve(versionsDir, current)
          : path.join(versionsDir, 'Current');
        if (!fs.existsSync(currentResolved) || !fs.statSync(currentResolved).isDirectory()) {
          errors.push(`${entry.name}: Versions/Current existiert nicht oder löst nicht auf (${current || 'kein Symlink'})`);
          continue;
        }
        for (const inner of fs.readdirSync(currentResolved, { withFileTypes: true })) {
          if (inner.isSymbolicLink()) {
            const t = fs.readlinkSync(path.join(currentResolved, inner.name));
            const r = path.resolve(currentResolved, t);
            if (!fs.existsSync(r)) {
              errors.push(`${entry.name}: toter Symlink in Versions/Current: ${inner.name} -> ${t}`);
            }
          }
        }
      }
    }
    if (opts.otool && executable && process.platform === 'darwin') {
      try {
        const otoolPath = opts.otoolPath || 'otool';
        const output = execFileSync(
          otoolPath,
          ['-L', path.join(bundle, 'Contents', 'MacOS', executable)],
          { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, encoding: 'utf-8' }
        );
        // @rpath-Auflösung wie dyld: LC_RPATH-Einträge des Bundles einlesen
        let rpaths = [];
        try {
          const rpathOut = execFileSync(
            otoolPath,
            ['-l', path.join(bundle, 'Contents', 'MacOS', executable)],
            { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, encoding: 'utf-8' }
          );
          rpaths = [...rpathOut.matchAll(/path\s+([^\s]+)\s+\(offset/i)].map(m => m[1]);
        } catch (_) {}
        for (const match of output.matchAll(/\t([^\t\n]+)\(/g)) {
          const lib = match[1].trim();
          if (lib.startsWith('/')) continue; // System-Library
          let candidates = [];
          if (lib.startsWith('@rpath/')) {
            const rest = lib.slice('@rpath/'.length);
            candidates = [
              path.join(bundle, 'Contents', 'Frameworks', rest),
              path.join(bundle, 'Contents', rest),
              ...rpaths.map(rp => path.resolve(bundle, rp.replace(/^@?executable_path/, ''), rest)),
              ...rpaths.map(rp => path.resolve(bundle, rp.replace('@loader_path', ''), rest)),
            ];
          } else if (lib.startsWith('@executable_path/')) {
            candidates = [path.join(bundle, 'Contents', 'MacOS', lib.slice('@executable_path/'.length))];
          } else if (lib.startsWith('@loader_path/')) {
            candidates = [path.join(bundle, 'Contents', 'MacOS', lib.slice('@loader_path/'.length))];
          } else {
            candidates = [path.join(bundle, 'Contents', 'Frameworks', lib)];
          }
          if (!candidates.some(c => fs.existsSync(c))) {
            errors.push(`dyld-Trockentest: Abhängigkeit nicht auflösbar: ${lib}`);
          }
        }
      } catch (e) {
        errors.push(`otool-Prüfung fehlgeschlagen: ${e.message}`);
      }
    }
  }

  if (opts.codesign) {
    if (process.platform !== 'darwin') {
      errors.push('codesign-Prüfung nur unter macOS möglich');
    } else {
      try {
        execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 120000,
        });
      } catch (e) {
        errors.push(`codesign --verify --deep --strict fehlgeschlagen: ${e.message}`);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

function listStaleEntries(dir, prefix) {
  try {
    return fs.readdirSync(dir)
      .filter(name => name.startsWith(prefix))
      .map(name => path.join(dir, name));
  } catch (_) {
    return [];
  }
}

function newest(paths) {
  return paths
    .map(p => ({ p, m: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0]?.p || null;
}

/**
 * Selbstheilung nach abgebrochenen Update-Läufen (Karte t_ea243f43 Schritt 2/
 * 5): Ein früherer Lauf darf NIEMALS den aktuellen Stand kalt löschen. Ist die
 * Installation durch einen Abbruch verloren gegangen (Support-Dir oder Wrapper
 * fehlen), wird der neueste erhaltene Rollback-Ordner zurückgeholt. Stale
 * Staging-Ordner werden geräumt. Nie wird eine intakte Installation angetastet.
 *
 * Rückgabe: { restored: string[] } — was zurückgeholt wurde.
 */
function recoverStaleUpdateDirs(supportDir, wrapper) {
  const restored = [];
  const supportParent = path.dirname(supportDir);
  const supportBase = path.basename(supportDir);

  // Stale Staging-Ordner sind unvollständige Kopien → gefahrlos löschbar.
  for (const p of listStaleEntries(supportParent, `${supportBase}.update-staging-`)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
  if (wrapper) {
    const wrapperParent = path.dirname(wrapper);
    for (const p of [
      ...listStaleEntries(wrapperParent, `${path.basename(wrapper)}.update-staging-`),
      ...listStaleEntries(wrapperParent, '.update-stage-'),
    ]) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }

  // Rollbacks: nur dann zurückholen, wenn der Live-Stand fehlt. Ist der
  // Live-Stand intakt vorhanden, bleibt der Rollback als Sicherheitsnetz liegen.
  if (!fs.existsSync(supportDir)) {
    const rollbacks = listStaleEntries(supportParent, `${supportBase}.update-rollback-`);
    const source = newest(rollbacks);
    if (source) {
      fs.renameSync(source, supportDir);
      restored.push(supportDir);
    }
  }
  if (wrapper && !fs.existsSync(wrapper)) {
    const rollbacks = listStaleEntries(path.dirname(wrapper), `${path.basename(wrapper)}.update-rollback-`);
    const source = newest(rollbacks);
    if (source) {
      fs.renameSync(source, wrapper);
      restored.push(wrapper);
    }
  }
  return { restored };
}

/**
 * Räumt ALLE stale Update-Artefakte (Staging + Rollbacks) weg — wird erst
 * NACH bestandener End-Verifikation der neuen Installation aufgerufen, wenn
 * der alte Stand definitiv nicht mehr gebraucht wird.
 */
function sweepStaleUpdateDirs(supportDir, wrapper) {
  const removed = [];
  const supportParent = path.dirname(supportDir);
  for (const prefix of [
    `${path.basename(supportDir)}.update-staging-`,
    `${path.basename(supportDir)}.update-rollback-`,
  ]) {
    for (const p of listStaleEntries(supportParent, prefix)) {
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(p);
    }
  }
  if (wrapper) {
    const wrapperParent = path.dirname(wrapper);
    for (const prefix of [
      `${path.basename(wrapper)}.update-staging-`,
      `${path.basename(wrapper)}.update-rollback-`,
      '.update-stage-',
    ]) {
      for (const p of listStaleEntries(wrapperParent, prefix)) {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(p);
      }
    }
  }
  return { removed };
}

module.exports = {
  copyBundleTree,
  verifyBundleIntegrity,
  recoverStaleUpdateDirs,
  sweepStaleUpdateDirs,
  listSymlinks,
  readBundleExecutable,
};
