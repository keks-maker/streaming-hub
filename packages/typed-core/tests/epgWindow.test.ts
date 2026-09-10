import { describe, expect, it } from 'vitest';
import {
  absoluteTimeToWindowOffsetSec,
  computeEpgMarkers,
  windowOffsetSecToAbsoluteTime,
} from '../src/epgWindow.js';
import { parseEpgTime } from '../src/epg.js';
import type { EpgEntry } from '../src/types.js';

const T = (utc: string) => Date.parse(utc);
// XMLTV-Format mit +0200 → parseEpgTime liefert korrekten Absolutwert
const X = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const tz =
    -d.getTimezoneOffset() >= 0 ? '+' : '-';
  const off = Math.abs(d.getTimezoneOffset());
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    ` ${tz}${pad(Math.floor(off / 60))}${pad(off % 60)}`
  );
};

// Einheitliche Testzone (wird nicht von DST beeinflusst, Basis: Europe/Berlin)
const GMT3 = 3 * 3600 * 1000;
const base = T('2026-09-08T12:00:00Z');

function makeEntries(): EpgEntry[] {
  // Sendungen um 12:00 UTC: 10:00–13:00, 13:00–14:00, 14:00–15:00
  const eps: EpgEntry[] = [
    { channelId: 'test.de', title: 'A', start: X('2026-09-08T10:00:00Z'), stop: X('2026-09-08T13:00:00Z') },
    { channelId: 'test.de', title: 'B', start: X('2026-09-08T13:00:00Z'), stop: X('2026-09-08T14:00:00Z') },
    { channelId: 'test.de', title: 'C', start: X('2026-09-08T14:00:00Z'), stop: X('2026-09-08T15:00:00Z') },
  ];
  return eps;
}

describe('computeEpgMarkers', () => {
  it('marker für Sendungen, die das Fenster schneiden', () => {
    // Fenster: 11:00–13:30 UTC
    const winStart = T('2026-09-08T11:00:00Z');
    const winEnd = T('2026-09-08T13:30:00Z');
    const markers = computeEpgMarkers(makeEntries(), winStart, winEnd);
    expect(markers.map(m => m.title)).toEqual(['A', 'B']);
  });

  it('Sendung vor/nach Fenster wird nicht gemarkert', () => {
    const winStart = T('2026-09-08T14:30:00Z');
    const winEnd = T('2026-09-08T15:00:00Z');
    const markers = computeEpgMarkers(makeEntries(), winStart, winEnd);
    expect(markers.map(m => m.title)).toEqual(['C']);
  });

  it('Grenzfall: Sendung endet exakt am Fensterstart → kein Marker', () => {
    const winStart = T('2026-09-08T13:00:00Z');
    const winEnd = T('2026-09-08T13:30:00Z');
    const entries: EpgEntry[] = [
      { channelId: 'x', title: 'vorher', start: X('2026-09-08T12:00:00Z'), stop: X('2026-09-08T13:00:00Z') },
    ];
    expect(computeEpgMarkers(entries, winStart, winEnd)).toEqual([]);
  });

  it('Grenzfall: Sendung beginnt exakt am Fensterende → kein Marker', () => {
    const winStart = T('2026-09-08T12:00:00Z');
    const winEnd = T('2026-09-08T13:00:00Z');
    const entries: EpgEntry[] = [
      { channelId: 'x', title: 'später', start: X('2026-09-08T13:00:00Z'), stop: X('2026-09-08T14:00:00Z') },
    ];
    expect(computeEpgMarkers(entries, winStart, winEnd)).toEqual([]);
  });

  it('sortiert nach Startzeit', () => {
    const winStart = T('2026-09-08T10:00:00Z');
    const winEnd = T('2026-09-08T15:00:00Z');
    const markers = computeEpgMarkers(makeEntries(), winStart, winEnd);
    expect(markers.map(m => m.title)).toEqual(['A', 'B', 'C']);
    expect(markers[0]!.startMs <= markers[1]!.startMs && markers[1]!.startMs <= markers[2]!.startMs).toBe(true);
  });

  it('windowOffsetSec = Sekunden von Fensterstart zu Programmstart; Programm vor Fensterstart → 0', () => {
    const winStart = T('2026-09-08T13:30:00Z');
    const winEnd = T('2026-09-08T14:30:00Z');
    const markers = computeEpgMarkers(makeEntries(), winStart, winEnd);
    expect(markers.map(m => m.title)).toEqual(['B', 'C']);
    // B begann VOR Fensterstart (13:00 < 13:30) → Marker am Position 0 des Fensters
    expect(markers[0]!.windowOffsetSec).toBe(0);
    // C beginnt 14:00 → 1800 s nach Fensterstart
    expect(markers[1]!.windowOffsetSec).toBe(1800);

    // Zweites Fenster: nach B-Start, B nicht mehr im Fenster
    const winStart2 = T('2026-09-08T12:30:00Z');
    const winEnd2 = T('2026-09-08T14:30:00Z');
    const m2 = computeEpgMarkers(makeEntries(), winStart2, winEnd2);
    expect(m2.map(m => m.title)).toEqual(['A', 'B', 'C']);
    // A begann VOR Fensterstart → 0
    expect(m2[0]!.windowOffsetSec).toBe(0);
    // B beginnt 13:00 → 1800 s nach Fensterstart
    expect(m2[1]!.windowOffsetSec).toBe(1800);
    // C beginnt 14:00 → 5400 s
    expect(m2[2]!.windowOffsetSec).toBe(5400);
  });

  it('leere Eingabe → leere Marker', () => {
    expect(computeEpgMarkers([], base, base + GMT3)).toEqual([]);
  });
});

describe('absoluteTimeToWindowOffsetSec', () => {
  it('MAP innerhalb des Fensters korrekt', () => {
    const ws = base;
    const we = base + 7200 * 1000;
    expect(absoluteTimeToWindowOffsetSec(base + 1800 * 1000, ws, we)).toBe(1800);
  });

  it('MAP außerhalb des Fensters', () => {
    const ws = base;
    const we = base + 7200 * 1000;
    expect(absoluteTimeToWindowOffsetSec(base - 1000, ws, we)).toBeNull();
    expect(absoluteTimeToWindowOffsetSec(we + 1, ws, we)).toBeNull();
    expect(absoluteTimeToWindowOffsetSec(NaN, ws, we)).toBeNull();
  });
});

describe('windowOffsetSecToAbsoluteTime', () => {
  it(' Rückumwandlung korrekt', () => {
    const ws = base;
    const we = base + 7200 * 1000;
    expect(windowOffsetSecToAbsoluteTime(1800, ws, we)).toBe(base + 1800 * 1000);
  });

  it('negativer Offset → null', () => {
    const ws = base;
    const we = base + 7200 * 1000;
    expect(windowOffsetSecToAbsoluteTime(-1, ws, we)).toBeNull();
    expect(windowOffsetSecToAbsoluteTime(7500, ws, we)).toBeNull();
  });
});
