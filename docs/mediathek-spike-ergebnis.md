# Mediathek-Spike (Etappe 1) - Ergebnis

Stand 2026-10-20, Abrufe aus Deutschland (arte meldet `userCountryCode: DE`), Node 22 (`fetch`), ffmpeg 7.1 aus `bin/ffmpeg` (arm64).
Skripte: `scripts/spike-mediathek/` (`lib.js`, `ard.js`, `ard-series.js`, `ard-season.js`, `zdf.js`, `arte.js`, `arte-series.js`, `dl-http.js`, `dl-hls.js`, `checks.js`). Testdateien waren im Scratchpad und sind gelöscht. Nicht committen.

Geo-Hinweis: Abrufe von außerhalb DE/EU konnten nicht getestet werden (nur DE-IP verfügbar). Alles zu Geoblock stammt aus API-Feldern, nicht aus Gegenproben.

## 1. Stream-Varianten je Quelle

| | ARD | ZDF | arte |
|---|---|---|---|
| Endpunkt | `api.ardmediathek.de/page-gateway/pages/<partner>/item/<id>?devicetype=pc&embedded=true` | `zdf-prod-futura.zdf.de/mediathekV2/document/<docId>` | `api.arte.tv/api/player/v2/config/de/<programId>` |
| Pfad Streams | `widgets[type=player_ondemand].mediaCollection.embedded.streams[].media[]` | `document.formitaeten[]` | `data.attributes.streams[]` |
| Typ | `mimeType`: `video/mp4` (progressiv) oder `application/vnd.apple.mpegurl` | `type`: `h264_aac_mp4_http_na_na`, `h264_aac_ts_http_m3u8_http`, `h265_aac_mp4_http_na_na` (nur UHD); `mimeType` | `protocol`: `API_HLS_NG_MA` (HLS, CMAF/fMP4) |
| Qualität | `forcedLabel` ("SD 360p", "SD 540p", "HD 720p", "HD 1080p", HLS "Auto") | `quality`: `low`/`high`/`veryhigh`/`hd`/`fhd`/`uhd`, HLS zusätzlich `auto`, `med` | nur im Master (6 Varianten: 432p/720p/1080p, je H.264 und H.265) |
| Auflösung | `maxHResolutionPx`, `maxVResolutionPx` | nicht im Feld; aus Dateiname (`_3328k_p15`) bzw. HLS-Master; ZDF `hd`/`fhd` = 720p/1080p | `RESOLUTION` im Master |
| Bitrate | nicht im JSON (nur HLS-Master `BANDWIDTH`; Dateiname bei universal-vod) | Dateiname (`508k/808k/1628k/3328k/6628k`), UHD 4692k HEVC | `BANDWIDTH`/`AVERAGE-BANDWIDTH` im Master (ca. 1,3 bis 4,6 Mbit/s) |
| Codec | `videoCodec` (immer "H.264" gesehen) | im `type` | `CODECS` im Master (avc1 und hev1) |
| Sprache/Ton | `audios[].languageCode` (`deu`, `ov`), `audios[].kind` | `language` (`deu`), `class` (`main` / `ad`) | `versions[].audioLanguage`, `shortLabel`, Master EXT-X-MEDIA |
| Typ Ton | `audios[].kind`: `standard`, `audio-description`, `speech-optimized` (Klare Sprache) | `class`: `main`, `ad` (Audiodeskription) | `versions[].audioDescription` (bool), `closedCaptioning` |

Beobachtungen:
- ARD: 4 MP4-Stufen (360/540/720/1080p, 1080p ca. 5 Mbit/s) plus 1 HLS-Master pro Tonvariante. HLS-Master ist reine Videovariantenliste (270 bis 1080p), Audio muxed. Die URLs im JSON sind ohne Token (`wdr-progressive.ard-mcdn.de`, `ctv-videos.daserste.de`, `*.akamaihd.net/i/...csmil`).
- ARD Reihenfolge der `media[]`-Einträge ist NICHT stabil: bei Kindersendungen kam `audio-description` vor `standard`. Der Swift-Code (`parseARDStreamDetail`) nimmt den ersten HLS-Eintrag in `kind == main` ohne Prüfung von `audios[0].kind`; das kann die Hörfilm-Fassung erwischen. In Node nach `audios[0].kind === 'standard'` filtern.
- ARD `streams[].kind`: `main` (alles inkl. AD/Klare Sprache) und `sign-language` (Gebärdensprache, 5 Einträge, eigenes Bild).
- ZDF: 12 bis 26 Formitäten je Dokument; jede Qualität doppelt als `main` und `ad`. Zwei MP4-Hosts (`nrodlzdf-a`, `rodlzdf-a` Mirror, letzterer nur bis `veryhigh`). `uhd` (HEVC) nur bei ausgewählten Titeln (Bergdoktor).
- arte: bei Serien/Filmen 1 Stream mit mehreren `versions` (alles im selben Master); bei manchen Programmen (Magazin 135639-000-A) je Version ein eigener Stream mit `slot` (1=DE, 2=FR), jeweils eigenes Manifest.

## 2. Tonspuren und HLS-Master

| Quelle | Master-Struktur |
|---|---|
| ARD | keine EXT-X-MEDIA; Tonvarianten (Standard, Audiodeskription, Klare Sprache) sind getrennte Master-URLs bzw. MP4-Dateien (`_sendeton_`, `_audiodeskription_`, `_klaresprache_`). OV ist ein eigener Mediathek-Eintrag. |
| ZDF | Master mit `audiotrack`-Query: `EXT-X-MEDIA TYPE=AUDIO GROUP-ID="audio0" NAME="TV Ton" LANGUAGE="de" DEFAULT=YES` und `NAME="Audiodeskription" AUTOSELECT=NO`. Keine Untertitel im Master, keine CHARACTERISTICS. Audiodeskription also nur über NAME erkennbar. AD zusätzlich als `class: ad`. |
| arte | Voll ausgebaut: `EXT-X-MEDIA TYPE=AUDIO` (de, fr, Original z. B. it/nl, AD, "Klare Sprache") und `TYPE=SUBTITLES`. `CHARACTERISTICS` enthält `tv.arte.audio.version.<code>` und `public.accessibility.describes-video` (AD) bzw. `enhances-speech-intelligibility` (Klare Sprache). Untertitel: `...transcribes-spoken-dialog` + `describes-music-and-sound` (SDH), `tv.arte.subtitle.mandatory` mit `FORCED=YES` (nur fremdsprachige Passagen). |

arte-Versionen laut `versions[]` (Beispiel 026377-000-A): `VA-STA` DE, `VA-STMA` UT (SDH, `closedCaptioning:true`), `VF-STF` FR, `VO-STF` OmU (`audioLanguage: it`, `subtitleLanguage: fr`), `VF-STMF`, `VAAUD`/`VFAUD` (`audioDescription:true`). Welche tatsächlich im Master liegen, bestimmt der Master (EXT-X-MEDIA), nicht `versions` (dort stehen teils mehr).

ARD-Varianten als eigene Einträge (Grouping-Liste, Titel-Suffix): `(Originalversion)`, `(Audiodeskription)`; IDs enden z. B. auf `.../audiodeskription` (Base64-URL, Teil der Item-ID). OV-Item: `audios[0].languageCode == "ov"`, `binaryFeatures: ["OV"]`, keine Untertitel in `embedded.subtitles`. Grouping-Widget kennt Flags `withAudiodescription`, `withOriginalversion`, `withOriginalWithSubtitle`, `withSignLanguage`.

## 3. Untertitel

| Quelle | Feld | Formate |
|---|---|---|
| ARD | `mediaCollection.embedded.subtitles[]`: `{kind: "normal"|"closed-captions", languageCode, sources[{kind:"ebutt"|"webvtt", url}]}`; Medien-Feld `hasEmbeddedSubtitles`/`media[].subtitles` leer | EBU-TT-D (TTML) und WebVTT, URL `api.ardmediathek.de/player-service/subtitle/webvtt/urn:ard:subtitle:<id>.vtt` |
| ZDF | `document.captions[]`: `{class: "hoh", format: "ebu-tt-d-basic-de"|"webvtt", language, offset, uri}` | TTML (.xml) und WebVTT (.vtt) auf `utstreaming.zdf.de/mtt/...`; alle `class: hoh` (für Hörgeschädigte, inkl. Geräuschbeschreibungen) |
| arte | nur über HLS-Master `EXT-X-MEDIA TYPE=SUBTITLES`; die URI ist eine VOD-Playlist mit einer einzigen `.vtt` (relative URL, `EXTINF` = Gesamtdauer) | WebVTT |

Konvertierung (getestet mit ffmpeg 7.1): WebVTT -> SRT und WebVTT -> `mov_text` funktionieren (ARD, ZDF; `<c.textWhite>`-Tags werden entfernt, leere erste Cue entfällt). TTML/EBU-TT-D wird von ffmpeg NICHT gelesen (`Invalid data found`; nur ein TTML-Muxer). Empfehlung: ausschließlich WebVTT verwenden, TTML ignorieren. arte-Playlist-URI kann direkt als ffmpeg-Eingang dienen (HLS-Demuxer liest die VTT-Playlist).

## 4. Download-Machbarkeit (getestet)

| Test | Ergebnis |
|---|---|
| ARD MP4 per HTTP | `HEAD` 200, `Accept-Ranges: bytes`, Range-Resume liefert 206 mit korrektem `Content-Range`; 6 MB in zwei Etappen, ffprobe h264+aac, 720p OK. Größe 720p-Folge 34 min ca. 589 MB. |
| ZDF MP4 per HTTP | wie ARD (Range 206); 720p-Film 90 min ca. 1,76 GB; AD-Variante eigene Datei gleicher Größe. |
| ARD HLS (`akamaihd.net/i/...csmil`) -> MP4, `-c copy` | OK, 30 s Material in 0,8 s (deutlich schneller als Echtzeit). |
| ZDF HLS Master (TV Ton + Audiodeskription) -> MP4 und MKV, `-c copy` | OK. Video-Variante + 2 Audio-EXT-X-MEDIA als getrennte Eingänge (`-i variant -i aud1 -i aud2`). TS/AAC wird für MP4 automatisch mit `aac_adtstoasc` versehen. |
| arte HLS (CMAF) -> MP4 und MKV, 1 Video + 2 Audio (DE, AD) + 5 Untertitel | OK. H.264 und H.265 (`-tag:v hvc1` für MP4/QuickTime) getestet; Original-Ton (it) ebenfalls. |
| ARD: Standard- + AD-Ton aus zwei MP4-Dateien muxen + WebVTT -> MP4 (`mov_text`) und MKV (`srt`) | OK (`-map 0:v -map 0:a -map 1:a -map 2:s`). |

Container-Kombinationen:
- MP4: mehrere AAC-Spuren und `mov_text`-Untertitel funktionieren (Titel der Tonspuren gehen im MP4 verloren; nur `language` und Disposition bleiben; Untertitel-Disposition `hearing_impaired` bleibt, `forced` wird gesetzt). Spielt in QuickTime/Apple TV; Untertitelkonvertierung auf Text beschränkt.
- MKV: alles inkl. Titeln (`title=`), `srt`-Untertitel, Dispositionen. Robuster für Mehrspur.
- Gesamtfazit: Stream-Copy genügt in allen Fällen, kein Transcode nötig.
- Wichtig: `-i` einer Master-Playlist mit allen Varianten (`-map 0`) liefert alle Varianten als Programme; stattdessen Master selbst parsen und Eingänge einzeln übergeben (siehe `dl-hls.js`).
- Zeit-Hinweis: `-t 30` als Eingangsoption begrenzt VTT-Spuren nicht immer; im Testskript deshalb auch als Ausgangsoption gesetzt (nur Testartefakt, Vollladung nicht betroffen).

## 5. Staffel-/Episodeninfo

| Feld | ARD | ZDF | arte |
|---|---|---|---|
| Serientitel | `meta.seriesTitle` (Item) / `widgets[].show.title` | `document.brandTitle` | nicht im Player-Config; aus Sammlungsseite (`pages/RC-.../` `title`) |
| Staffel | nicht als Feld im Teaser/Item; Grouping-Widget `seasonNumber` bei Abruf mit `seasoned=true&seasonNumber=N`; `widgets[].show.availableSeasons` (["1".."5"]); sonst Titel-Regex `\(S(\d+)/E(\d+)\)` | `document.seasonNumber` (String, "19"; bei Magazinen Jahr "2026") | Zonentitel `collection_subcollection.title` ("Occupied - Die Besatzung - Staffel 2"); Episodentitel `... Staffel 2 (1/8)` |
| Folge | Titel-Regex `(S05/E08)`; Titel enthält teils "Folge 8 · Staffel 5" | `document.episodeNumber` (String "01"); bei Zweiteilern doppelt (Bergdoktor S17: zwei Teile je E01) | Titel-Regex `\((\d+)/(\d+)\)`, `subtitle` = Folgentitel |
| Sendedatum | `widget.broadcastedOn` / `meta.broadcastedOnDateTime` (ISO) | `document.airtime` ("19.03.2026 01:00", deutsch formatiert), `date` | `availability.start` (Verfügbarkeit, nicht Sendedatum) |
| Verfügbar bis | `widget.availableTo` / `meta.availableToDateTime` | `document.offlineAvailability` (ISO, Winterzeit `+01:00`) bzw. `timetolive` ("15.03.2031 10:00") | `rights.end` (player) / `availability.end` (Teaser) |
| Dauer | `meta.durationSeconds` | `document.length` | `metadata.duration.seconds` |
| Serienliste | `pages/<p>/grouping/<id>?embedded=true` (48 pro Seite, `pagination.totalElements`); Staffel: `widgets/ard/asset/<groupingId>?seasoned=true&seasonNumber=N&pageSize=48&embedded=true` | `document/<brandId>`: `cluster[]` mit `name` "Staffel N - alle verfügbaren Folgen" und `teaser[]` | `pages/RC-xxxxxx/`: Zonen `collection_videos`, `collection_subcollection` (je Staffel eine Zone) |

Dateinamen-Empfehlung `Serie - S01E02 - Titel`: ARD aus Titel-Regex (Staffel aus Widget-Abruf), ZDF aus `seasonNumber`/`episodeNumber` nur wenn Staffel < 1900 (sonst Jahr -> `Serie - 2026-03-19 - Titel`), arte aus Zonentitel + Titel-Regex; Fallback immer `Serie - YYYY-MM-DD - Titel`. Extras (ARD `coreAssetType` `EXTRA_*`, ZDF `contentType: clip`) herausfiltern.

## 6. Besonderheiten

- **Geoblock**: ARD `embedded.isGeoBlocked: true` bedeutet "nur regional" und ist bei gelieferten Streams nur Hinweis (trat hier bei fast allen Items auf, Streams liefen trotzdem aus DE). ZDF `geoLocation` (`none`/`de`), arte `restriction.geoblocking` (`code`, `inclusion`, `userGeoblockingZone`, `restrictedArea`). Nicht-DE-Test nicht möglich.
- **FSK / Jugendschutz**: ARD: `widget.blockedByFsk: true`, `maturityContentRating: "FSK16"`, `mediaCollection` fehlt ganz (FSK16 tagsüber gesperrt). ZDF: `fskCheck: true`, `formitaeten: []`, Stream nur über `api.zdf.de` (HTTP 403 ohne Token) - nicht ohne Zugangs-Token herunterladbar; betrifft auch die im ZDF gelisteten ARD-Beiträge (`page-video-ard-*`). arte: `streams: []`, `error.code: ERROR_AGE_RESTRICTION_16`, `error.message` "nur von 22 bis 6 Uhr", `restriction.timeSlot {startDate,endDate}`; Teaser tragen `ageRating` (Zahl). Download deshalb prüfen: Zeitfenster abwarten bzw. Meldung anzeigen.
- **Token-Ablauf**: In den URLs keine Token-Parameter (`hdnea`, `token`, `exp`) bei ARD, ZDF, arte. Master-Playlists: ARD/ZDF `Cache-Control: max-age=10` (neu abrufbar, nicht entscheidend), arte-Manifest `max-age=983301`. ZDF-Master-URL trägt `audiotrack=` in der Query (Parameter, kein Token). Echte Ablaufzeit nicht gemessen; Empfehlung: Stream-URLs direkt vor dem Download frisch auflösen und bei Fehler 403/404 einmal neu auflösen (z. B. vor Resume).
- **Rate-Limits**: 40 Abrufe je API (8 parallel) ohne 429/Retry-After (ARD 0,6 s, ZDF 0,2 s, arte 0,4 s). Trotzdem Parallelität begrenzen und `User-Agent` setzen (Swift nutzt `StreamingHub/1.0`).
- **DRM**: bei allen getesteten Streams kein `EXT-X-KEY`/Verschlüsselung (Master und Variante), keine DRM-Felder. Alle Downloads per Stream-Copy ohne Entschlüsselung. Keine Widevine-Streams gesehen (Live/Sport nicht geprüft).
- **Dynamische Qualität**: arte ordnet Varianten nicht nach Auflösung; Bandbreite des H.265 ist teils größer als H.264 gleicher Auflösung (AVERAGE-BANDWIDTH ähnlich) - bei Auswahl Codec explizit wählen.

## Empfohlene Defaults

- Container: **MKV** als Standard bei Mehrspur (mehrere Töne/Untertitel, Titel, `srt`); **MP4** wenn der Nutzer Apple-Kompatibilität wählt (`mov_text`, `-tag:v hvc1` bei HEVC, `-movflags +faststart`). Einstellbar je Download.
- Video: höchste verfügbare Stufe bis 1080p; arte H.264 (breitere Kompatibilität) vor H.265; ZDF/ARD MP4-Direktdownload (Range-Resume) bevorzugen, wenn nur eine Tonspur gewünscht; HLS + ffmpeg bei mehreren Tonspuren/arte.
- Ton: Standardspur (ARD `standard`, ZDF `main`/"TV Ton", arte Version DE bzw. Original je nach Sprache) als Default-Disposition; Audiodeskription und OV nur auf Wunsch, als zusätzliche Spur mit `-disposition visual_impaired`; Sprache als ISO-639-2 (`deu`, `fra`, `ita`).
- Untertitel: standardmäßig WebVTT-Spuren in der Nutzersprache (de) mit; "Hörgeschädigte"-Spur (SDH) als `hearing_impaired`; arte-Forced-Spur (`FORCED=YES`) als `forced` übernehmen oder weglassen. Als `mov_text` (MP4) bzw. `srt` (MKV). Zusätzlich wählbar: separate `.srt`-Datei neben dem Video.
- Meta-Tags: `title`, `show`, `season_number`, `episode_sort`, `date` (Sendedatum) per `-metadata` setzen.
- Fehlerbehandlung: FSK/Zeitfenster/ZDF-fskCheck/Geoblock vorab erkennen und verständlich melden; Abbruch/Resume über Range (nur MP4-HTTP; HLS-Abbruch = Neustart oder Segmentliste).
