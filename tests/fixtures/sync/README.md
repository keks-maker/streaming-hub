# Abgleich-Testvektoren (D10)

Kopie der sprachneutralen Vektoren aus dem Apple-Repo (StreamingHub-tvOS), Pfad
`Tests/StreamingHubCoreTests/Fixtures/sync/*.json`, Branch `feature/d10-icloud-sync-engine`, Stand Commit `d92b518`
(Kopie 2026-11-21). Die Vektoren werden nach der Core-QA von Paket 2 erneut abgeglichen. Die Regel steht in der dortigen `README.md` und ist in `lib/sync-merge.js` umgesetzt;
`tests/sync-merge.test.js` lässt alle `*.json` hier dagegen laufen und prüft sie gegen die feste Namensliste `manifest.json` (fehlende oder zusätzliche Datei = rot). Neue Vektoren aus dem Apple-Repo unverändert
hierher kopieren und den Commit-Hash oben und `manifest.json` nachziehen.
