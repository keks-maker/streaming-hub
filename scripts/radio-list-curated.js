'use strict';

// Kuratierte Pflichtsender für scripts/build-radio-list.js (Konzept §3.1): öffentlich-rechtliche Landeswellen.
// id: stabile Sender-ID in radiosources.json (bestehende IDs unverändert), match: Name-Muster im radio-browser-Verzeichnis,
// search: Suchbegriff für die API, falls der Sender nicht in den Top-Votes steht, fallbackUrl: tokenfreie Adresse als
// Ersatz, wenn das Verzeichnis nur Adressen mit Zugangsdaten/Token liefert.
const REQUIRED = [
  { id: 'swr1-bw', name: 'SWR1 Baden-Württemberg', match: /^SWR ?1 (BW|Baden)/i, search: 'SWR1 BW', genre: 'Pop', region: 'BW' },
  { id: 'swr1-rp', name: 'SWR1 Rheinland-Pfalz', match: /^SWR ?1 (RP|Rheinland)/i, search: 'SWR1 Rheinland-Pfalz', genre: 'Pop', region: 'RP' },
  { id: 'swr3', name: 'SWR3', match: /^SWR ?3\b/i, search: 'SWR3', genre: 'Pop', region: 'BW/RP' },
  { id: 'swr4-bw', name: 'SWR4 Baden-Württemberg', match: /^SWR ?4 (BW|Baden)/i, search: 'SWR4 BW', genre: 'Schlager', region: 'BW' },
  { id: '1live', name: '1LIVE', match: /^(WDR )?1 ?LIVE$/i, search: '1LIVE', genre: 'Pop', region: 'NRW' },
  { id: 'wdr2-rheinland', name: 'WDR 2 Rheinland', match: /^WDR ?2 Rheinland$/i, search: 'WDR 2 Rheinland', genre: 'Pop', region: 'NRW' },
  { id: 'wdr4', name: 'WDR 4', match: /^WDR ?4$/i, search: 'WDR 4', genre: 'Schlager', region: 'NRW' },
  { id: 'wdr5', name: 'WDR 5', match: /^WDR ?5$/i, search: 'WDR 5', genre: 'Information', region: 'NRW' },
  { id: 'ndr-1-niedersachsen', name: 'NDR 1 Niedersachsen', match: /^NDR ?1 Nieders/i, search: 'NDR 1 Niedersachsen', genre: 'Pop', region: 'NI' },
  { id: 'ndr-2', name: 'NDR 2', match: /^NDR ?2( - Niedersachsen)?$/i, search: 'NDR 2', genre: 'Pop', region: 'NI' },
  { id: 'ndr-903', name: 'NDR 90,3', match: /^NDR 90[,.]?3$/i, search: 'NDR 90,3', genre: 'Pop', region: 'HH' },
  { id: 'br1', name: 'Bayern 1', match: /^Bayern 1( Oberbayern)?$/i, search: 'Bayern 1', genre: 'Schlager', region: 'BY' },
  { id: 'bayern-3', name: 'Bayern 3', match: /^Bayern ?3$/i, search: 'Bayern 3', genre: 'Pop', region: 'BY' },
  { id: 'br-bayern-2', name: 'Bayern 2', match: /^Bayern ?2$/i, search: 'Bayern 2', genre: 'Information', region: 'BY' },
  { id: 'hr1', name: 'hr1', match: /^hr ?1$/i, search: 'hr1', genre: 'Pop', region: 'HE' },
  { id: 'hr3', name: 'hr3', match: /^hr ?3$/i, search: 'hr3', genre: 'Pop', region: 'HE' },
  { id: 'hr4', name: 'hr4', match: /^hr ?4\s*$/i, search: 'hr4', genre: 'Schlager', region: 'HE' },
  { id: 'mdr-jump', name: 'MDR Jump', match: /^MDR Jump$/i, search: 'MDR Jump', genre: 'Pop', region: 'MDR' },
  { id: 'mdr-sachsen', name: 'MDR Sachsen', match: /^MDR Sachsen$/i, search: 'MDR Sachsen', genre: 'Information', region: 'SN' },
  { id: 'mdr-aktuell', name: 'MDR Aktuell', match: /^MDR Aktuell$/i, search: 'MDR Aktuell', genre: 'Information', region: 'MDR' },
  { id: 'mdr-klassik', name: 'MDR Klassik', match: /^MDR Klassik$/i, search: 'MDR Klassik', genre: 'Klassik', region: 'MDR' },
  {
    id: 'radioeins',
    name: 'Radio Eins',
    match: /^radio ?eins$/i,
    search: 'radioeins',
    genre: 'Pop',
    region: 'BE/BB',
    fallbackUrl: 'http://dispatcher.rndfnk.com/rbb/radioeins/live/mp3/mid',
  },
  { id: 'antenne-brandenburg', name: 'Antenne Brandenburg', match: /^Antenne Brandenburg$/i, search: 'Antenne Brandenburg', genre: 'Pop', region: 'BB' },
  { id: 'fritz', name: 'Fritz', match: /^Fritz$/i, search: 'Fritz', genre: 'Pop', region: 'BE/BB' },
  { id: 'sr3', name: 'SR 3 Saarlandwelle', match: /^SR ?3/i, search: 'SR3 Saarlandwelle', genre: 'Pop', region: 'SL' },
  { id: 'bremen-eins', name: 'Bremen Eins', match: /^Bremen (Eins|1)$/i, search: 'Bremen Eins', genre: 'Pop', region: 'HB' },
  { id: 'bremen-vier', name: 'Bremen Vier', match: /^Bremen (Vier|4)$/i, search: 'Bremen Vier', genre: 'Pop', region: 'HB' },
  { id: 'deutschlandfunk', name: 'Deutschlandfunk', match: /^Deutschlandfunk$/i, search: 'Deutschlandfunk', genre: 'Information', region: 'DE' },
  { id: 'deutschlandfunk-kultur', name: 'Deutschlandfunk Kultur', match: /^Deutschlandfunk Kultur$/i, search: 'Deutschlandfunk Kultur', genre: 'Kultur', region: 'DE' },
  { id: 'dlf-nova', name: 'Deutschlandfunk Nova', match: /^Deutschlandfunk Nova$/i, search: 'Deutschlandfunk Nova', genre: 'Pop', region: 'DE' },
];

// Die bestehenden Radiosender (Version vor R5) werden über Namen im Verzeichnis zugeordnet, damit sie eine rbUuid erhalten;
// ihre IDs und Stream-URLs bleiben unverändert.
module.exports = { REQUIRED };
