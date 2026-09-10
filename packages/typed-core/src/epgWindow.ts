import type { EpgEntry } from './types.js';
import { parseEpgTime } from './epg.js';

export interface EpgMarker {
  title: string;
  /** XMLTV start string of the program, as found in the EPG data. */
  start: string;
  /** Absolute start (ms epoch) of the program. */
  startMs: number;
  /** Absolute stop (ms epoch) of the program. */
  stopMs: number;
  /** Offset in seconds from DVR window start to program start.  */
  windowOffsetSec: number;
}

/**
 * Computes EPG markers that intersect the visible DVR window.
 * @param entries EPG entries for ONE channel.
 * @param windowStartMs absolute start (ms epoch) of the DVR window.
 * @param windowEndMs absolute end (ms epoch) of the DVR window (live edge).
 */
export function computeEpgMarkers(
  entries: EpgEntry[],
  windowStartMs: number,
  windowEndMs: number,
): EpgMarker[] {
  if (!entries || !entries.length) return [];
  const markers: EpgMarker[] = [];
  for (const e of entries) {
    const startMs = parseEpgTime(e.start).getTime();
    const stopMs = parseEpgTime(e.stop).getTime();
    if (!isFinite(startMs) || !isFinite(stopMs) || startMs === 0) continue;
    if (startMs < windowEndMs && stopMs > windowStartMs) {
      markers.push({
        title: e.title,
        start: e.start,
        startMs,
        stopMs,
        windowOffsetSec: Math.max(0, (startMs - windowStartMs) / 1000),
      });
    }
  }
  markers.sort((a, b) => a.startMs - b.startMs);
  return markers;
}

/**
 * Maps absolute wall-clock time (ms epoch) to position in DVR window (seconds from window start).
 * Returns null if the time is outside the window.
 */
export function absoluteTimeToWindowOffsetSec(
  timeMs: number,
  windowStartMs: number,
  windowEndMs: number,
): number | null {
  if (!isFinite(timeMs) || timeMs < windowStartMs || timeMs > windowEndMs) return null;
  return (timeMs - windowStartMs) / 1000;
}

/**
 * Maps position in DVR window (seconds from window start) to absolute wall-clock time (ms epoch).
 * Returns null if the position is outside the window.
 */
export function windowOffsetSecToAbsoluteTime(
  windowOffsetSec: number,
  windowStartMs: number,
  windowEndMs: number,
): number | null {
  if (!isFinite(windowOffsetSec) || windowOffsetSec < 0) return null;
  const ms = windowStartMs + windowOffsetSec * 1000;
  if (ms > windowEndMs) return null;
  return ms;
}
