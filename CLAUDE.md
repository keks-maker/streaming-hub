# Streaming Hub (Desktop) — Projektinfos

Electron-App (Castlabs, Widevine). Repo: GitHub `keks-maker/streaming-hub`. Doku: `README.md`, Änderungen: `CHANGELOG.md`.
Tests: `npm test`, Lint: `npm run lint`. Der Updater liefert Releases an Nutzer aus — Push nach `main` nach QA-OK ist dauerhaft freigegeben (Daueranweisung 27.10.2026, siehe Memory `feedback-worktree-nach-main`). Tag und Release nur nach ausdrücklicher Freigabe.
Schwesterprojekt: Apple-Repo `../StreamingHub-tvOS` (tvOS + iPad, Targets `StreamingHubTV`/`StreamingHubiPad`). Gemeinsame Formate: Skill `cross-platform-sync`.
Struktur: Renderer-Module im Wurzelordner (`epg-*`, `mediathek-*`, `podcast-*`, `radio-*`, `settings-*`, `youtube-*`), Main-Logik in `lib/` (u. a. `mediathek/`, `download/`, `epg/`, `radio/`, `podcast/`, `recorder/`), `e2e/` (Playwright, `platform.js` mit `backgroundEnv`), `tests/` (Unit), `packages/typed-core`, `scripts/`, `docs/`.
Arbeitsweise (Orchestrator/Dev/QA): siehe globale `~/.claude/CLAUDE.md`.
Tests und Selbstchecks starten die App nur im Hintergrund: `STREAMING_HUB_USER_DATA=<tmp>` + `STREAMING_HUB_E2E_BACKGROUND=1` (`backgroundEnv()` aus `e2e/platform.js`), neue Fenster per `revealWindow()`/`showInactive()`. Nie `npm start` zum Testen.
