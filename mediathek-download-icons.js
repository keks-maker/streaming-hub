'use strict';

// Symbole der Download-Zustände (statisches SVG, nur Zahlen werden eingesetzt): nicht geladen, Warteschlange, läuft (Ring mit
// Fortschritt), angehalten, zurückgestellt, fertig, Fehler. Farbe über currentColor bzw. CSS (.is-<zustand>).

const ATTRS = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const RING_LENGTH = 50.27; // Umfang für r = 8

const ICONS = {
  none: `<svg ${ATTRS}><path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>`,
  queued: `<svg ${ATTRS}><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/></svg>`,
  paused: `<svg ${ATTRS}><circle cx="12" cy="12" r="8"/><path d="M10 9v6M14 9v6"/></svg>`,
  scheduled: `<svg ${ATTRS}><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>`,
  done: `<svg ${ATTRS}><circle cx="12" cy="12" r="8"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>`,
  failed: `<svg ${ATTRS}><circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16.2v.1"/></svg>`,
};

/** Abo „Neue Folgen automatisch laden“: kreisende Pfeile mit Download-Pfeil. */
const AUTO_SVG = `<svg ${ATTRS}><path d="M20 12a8 8 0 0 1-13.7 5.6"/><path d="M4 12a8 8 0 0 1 13.7-5.6"/><path d="M18 3v4h-4"/><path d="M6 21v-4h4"/><path d="M12 9v5"/><path d="M10 12.5l2 2 2-2"/></svg>`;

/** SVG für einen Zustand; percent nur für „running“ (null = unbestimmt, der Ring dreht sich per CSS). */
function downloadIcon(state, percent = null) {
  if (state === 'running') {
    const known = typeof percent === 'number' && Number.isFinite(percent);
    const shown = known ? Math.max(3, Math.min(100, percent)) : 28;
    const dash = ((shown / 100) * RING_LENGTH).toFixed(2);
    return `<svg ${ATTRS}><circle cx="12" cy="12" r="8" stroke-opacity=".25"/><circle class="mediathek-dl-ring${known ? '' : ' is-spinning'}" cx="12" cy="12" r="8" stroke-dasharray="${dash} ${RING_LENGTH}" transform="rotate(-90 12 12)"/></svg>`;
  }
  return ICONS[state] || ICONS.none;
}

module.exports = { downloadIcon, AUTO_SVG, RING_LENGTH };
