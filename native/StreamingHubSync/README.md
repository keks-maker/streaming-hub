# StreamingHubSync (Mac-Hilfs-App)

Hilfs-App für den iCloud-Abgleich des Desktops (D10). Bundle-ID `tv.streaminghub.desktopsync`, Container
`iCloud.tv.streaminghub`, Zone `StreamingHub`, Records Progress/Recent/Queue. Protokoll: `PROTOCOL.md`.
Linkt den Core `../StreamingHub-tvOS` (Product `StreamingHubCore`) per lokalem Pfad.

- Tests: `cd native/StreamingHubSync && swift test` (Fake-Datenbank, kein iCloud-Zugriff)
- Release: `scripts/build-sync-helper.sh` (Build, Signatur Developer ID + Hardened Runtime + Profil, Notarisierung, Stapeln, zip)
- App-ID/Profil: `node scripts/provision-sync-helper.js` (ASC-API-Key in `~/.appstoreconnect/`)

Einmalig von Hand (per API nicht möglich): developer.apple.com > Certificates, Identifiers & Profiles > Identifiers >
`tv.streaminghub.desktopsync` > iCloud > Configure > Container `iCloud.tv.streaminghub` anhaken > Save. Danach
`node scripts/provision-sync-helper.js` erneut ausführen (erneuert das Profil, Exit 0 = Container enthalten).
Das Developer-ID-Zertifikat läuft am 01.02.2027 ab; danach Profil erneuern und neu signieren.
