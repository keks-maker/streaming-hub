# Streaming Hub (Desktop) — Projektinfos

Electron-App (Castlabs, Widevine). Repo: GitHub `keks-maker/streaming-hub`. Doku: `README.md`, Änderungen: `CHANGELOG.md`.
Tests: `npm test`, Lint: `npm run lint`. Der Updater liefert Releases an Nutzer aus — Push nach `main` nach QA-OK ist dauerhaft freigegeben (Daueranweisung 27.10.2026, siehe Memory `feedback-worktree-nach-main`). Tag und Release nur nach ausdrücklicher Freigabe.
Schwesterprojekt: Apple-Repo `../StreamingHub-tvOS` (tvOS + iPad, Targets `StreamingHubTV`/`StreamingHubiPad`). Gemeinsame Formate: Skill `cross-platform-sync`.
Struktur: Renderer-Module im Wurzelordner (`epg-*`, `mediathek-*`, `podcast-*`, `radio-*`, `settings-*`, `youtube-*`), Main-Logik in `lib/` (u. a. `mediathek/`, `download/`, `epg/`, `radio/`, `podcast/`, `recorder/`), `e2e/` (Playwright, `platform.js` mit `backgroundEnv`), `tests/` (Unit), `packages/typed-core`, `scripts/`, `docs/`.
Arbeitsweise (Orchestrator/Dev/QA): siehe globale `~/.claude/CLAUDE.md`.
Tests und Selbstchecks starten die App nur im Hintergrund: `STREAMING_HUB_USER_DATA=<tmp>` + `STREAMING_HUB_E2E_BACKGROUND=1` (`backgroundEnv()` aus `e2e/platform.js`), neue Fenster per `revealWindow()`/`showInactive()`. Nie `npm start` zum Testen.

## Design

- Verbindlich ist `docs/DESIGN.md` (Original nur in diesem Repo; das Apple-Repo verweist per `../streaming-hub/docs/DESIGN.md`). Vor jeder UI-Änderung lesen. Umbau in Schritten laut `docs/design-umbau-plan.md`, neue Sessions starten damit.
- Keine neuen Farbwerte, Radien, Abstände oder Schriftgrößen. Nur Tokens aus DESIGN.md (Desktop: CSS-Variablen, Swift: `StreamingHubCore/DesignTokens.swift`).
- Fehlt ein Token: nicht erfinden, sondern nachfragen und DESIGN.md ergänzen.
- Neue Ansichten bestehen nur aus Komponenten des Katalogs.
- Icons nur laut Zuordnungstabelle in DESIGN.md: Lucide auf dem Desktop, SF Symbols auf iPad und Apple TV. Keine Emojis, keine Schriftzeichen als Icons.
- Texte erfüllen WCAG AA (4,5 : 1), Bedienelemente 3 : 1, in Hell und Dunkel. Fokus ist ein Ring in `focus-ring`, keine Bereichsfarbe.
- Kein Text, der nur wiederholt, was ein Element tut („Öffnen“, „Bereich öffnen“).
- Jeder Bereich nutzt seine Bereichsfarbe (`area-*`) für Akzente.
- Jede UI-Änderung in Hell- und Dunkelmodus prüfen (Apple TV ist fest dunkel). Jedes Farb-Token braucht beide Werte.
- Änderungen an Tokens gelten für Desktop, iPad und Apple TV: im Commit vermerken.
- Ein Schritt pro Commit mit Präfix `design(<schritt>): …`; App nach jedem Schritt im Hintergrund starten und prüfen.
