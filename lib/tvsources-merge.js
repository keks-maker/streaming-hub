// 3-way-Merge für tvsources.json beim Update (v0.4.83).
//
// Problem: restoreUserFiles() überschrieb nach dem Checkout tvsources.json mit dem
// alten Geräte-Stand → im Release enthaltene channelOverrides (z. B. MDR Thüringen)
// wurden stillschweigend zurückgerollt.
//
// Lösung: echter 3-way-Merge zwischen
//   base = letzte auf dem Gerät committete Version (git show HEAD:tvsources.json vor dem Checkout)
//   old  = alte Geräte-Kopie (User-Daten: favorites, sortOrder, eigene channelOverrides)
//   neu  = committete Version des neuen Tags
//
// Regeln:
//   - favorites/sortOrder: User-Daten bleiben erhalten, WENN der User sie geändert hat
//     (old != base). Unveränderte (old == base) werden aus dem neuen Tag übernommen.
//   - channelOverrides pro Kanal: Hat der User den Eintrag selbst gesetzt/geändert
//     (old != base, oder nur in old vorhanden), gewinnt der User-Eintrag. Sonst gilt
//     der Eintrag aus dem neuen Tag (inkl. Entfernung, wenn der Tag ihn löscht).
//   - Quellen, die nur auf dem Gerät existieren (vom User ergänzt), bleiben erhalten.
//   - Struktur-Konflikt (nicht parsbar / kein Array): kein Merge möglich → Rückmeldung
//     an den Aufrufer, die alte Datei bleibt unverändert. NIE Datenverlust.
//
// Reine Funktionen, keine Electron-/Node-APIs → ohne Electron unit-testbar.

/**
 * Struktur-übergreifender Vergleich. Objekte: Schlüsselmenge + Werte (reihenfolge-
 * unabhängig). Arrays: reihenfolgeabhängig. So wird ein nur umsortiertes Override-
 * Objekt ({tvgId,url} vs {url,tvgId}) nicht fälschlich als User-Änderung gewertet.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a !== 'object') return a === b;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Merged eine Quelle (Element des tvsources-Arrays) zwischen base/old/neu.
 * Gibt { source, conflicts } zurück; conflicts = Liste lesbarer Konflikt-Hinweise
 * (reine Funktion – Warnungen gibt der Aufrufer aus).
 */
function mergeSource(base, old, neu) {
  // Neue Quelle (im Tag hinzugekommen) → unverändert übernehmen.
  if (!old) return { source: neu, conflicts: [] };
  // Nur auf dem Gerät vorhandene Quelle (User hat sie ergänzt / Tag hat sie entfernt)
  // → User-Kopie behalten.
  if (!neu) return { source: old, conflicts: [] };

  const out = { ...neu };
  const conflicts = [];
  const id = neu.id || old.id || '(ohne id)';

  // User-Favoriten/Sortierung: nur wenn der User sie selbst verändert hat.
  for (const field of ['favorites', 'sortOrder']) {
    const userTouched = !deepEqual(old[field], base ? base[field] : undefined);
    if (userTouched) {
      out[field] = old[field];
    }
    // sonst: Feld aus neu übernehmen (im out bereits enthalten).
  }

  // channelOverrides pro Kanal-Eintrag mergen.
  const baseOv = base && isPlainObject(base.channelOverrides) ? base.channelOverrides : {};
  const oldOv = isPlainObject(old.channelOverrides) ? old.channelOverrides : null;
  const neuOv = isPlainObject(neu.channelOverrides) ? neu.channelOverrides : {};

  if (old.channelOverrides !== undefined && !isPlainObject(old.channelOverrides)) {
    // Struktur, die wir nicht sicher zuordnen können → ganze Quelle aus User-Kopie behalten.
    conflicts.push(`${id}: channelOverrides hat unerwartetes Format – Quelle unverändert aus Geräte-Stand übernommen`);
    return { source: old, conflicts };
  }
  const mergedOv = {};
  const keys = new Set([...Object.keys(neuOv), ...Object.keys(oldOv)]);
  for (const ch of keys) {
    const inOld = Object.prototype.hasOwnProperty.call(oldOv, ch);
    const inBase = Object.prototype.hasOwnProperty.call(baseOv, ch);
    const inNeu = Object.prototype.hasOwnProperty.call(neuOv, ch);
    const userAuthored = inOld && (!inBase || !deepEqual(oldOv[ch], baseOv[ch]));
    if (userAuthored) {
      mergedOv[ch] = oldOv[ch];
    } else if (inNeu) {
      mergedOv[ch] = neuOv[ch];
    }
    // sonst: weder User-Eintrag noch im neuen Tag → Override wurde im Release entfernt.
  }
  if (Object.keys(mergedOv).length > 0) {
    out.channelOverrides = mergedOv;
  } else {
    delete out.channelOverrides;
  }

  return { source: out, conflicts };
}

/**
 * Führt base (committeter Stand auf dem Gerät), old (Geräte-Kopie) und neu
 * (committeter Stand des neuen Tags) zusammen.
 *
 * Alle drei Parameter: geparstes JSON oder null (nicht vorhanden/nicht lesbar).
 * options.warn: optionale Funktion für Warn-Hinweise (z. B. für Progress-Steps).
 *
 * Rückgabe:
 *   ok          – Merge durchführbar (dann value = gemergtes Array)
 *   value       – gemergtes tvsources-Array (nur bei ok)
 *   keepOld     – true: Merge nicht möglich, alte Geräte-Datei unverändert weiterverwenden
 *   reason      – lesbarer Grund (für Progress/Log)
 */
function mergeTvsources(base, old, neu, options) {
  const opts = options || {};
  const warn = typeof opts.warn === 'function' ? opts.warn : function () {};
  const conflicts = [];

  // Frisch-Installation ohne Geräte-Datei → committeter Stand des Tags.
  if (old === null || old === undefined) {
    return { ok: true, value: neu, keepOld: false, reason: 'keine Geräte-Kopie vorhanden – committeter Stand übernommen' };
  }
  // Neue Version ohne tvsources (sollte nicht vorkommen) → alte Datei behalten.
  if (neu === null || neu === undefined) {
    return { ok: false, keepOld: true, reason: 'neue Version enthält keine tvsources.json – Geräte-Stand beibehalten' };
  }
  if (!Array.isArray(old) || !Array.isArray(neu)) {
    return { ok: false, keepOld: true, reason: 'tvsources.json hat kein Array-Format – Merge übersprungen, Geräte-Stand beibehalten' };
  }

  const baseById = new Map();
  if (Array.isArray(base)) {
    for (const s of base) {
      if (s && s.id !== undefined) baseById.set(s.id, s);
    }
  }

  const neuById = new Map();
  for (const s of neu) {
    if (s && s.id !== undefined) neuById.set(s.id, s);
  }

  // 1) Alle Quellen aus der Geräte-Kopie durchgehen (User-Daten-Quellen zuerst,
  //    Reihenfolge der Geräte-Datei bleibt erhalten).
  const merged = [];
  const handledIds = new Set();
  for (const s of old) {
    if (!s || s.id === undefined) {
      // Quelle ohne id kann nicht zugeordnet werden → unverändert übernehmen.
      merged.push(s);
      continue;
    }
    handledIds.add(s.id);
    const r = mergeSource(baseById.get(s.id), s, neuById.get(s.id), warn);
    conflicts.push(...r.conflicts);
    merged.push(r.source);
  }

  // 2) Im neuen Tag hinzugekommene Quellen anhängen (in Tag-Reihenfolge).
  for (const s of neu) {
    if (s && s.id !== undefined && !handledIds.has(s.id)) merged.push(s);
  }

  for (const c of conflicts) warn(c);

  return { ok: true, value: merged, keepOld: false, conflicts };
}

module.exports = { mergeTvsources, deepEqual };
