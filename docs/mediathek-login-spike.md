# Spike: Mediathek-Login für Jugendschutz-Freigabe (Stand 20.10.2026)

Methode: nur öffentliche Hilfeseiten, HTML/JS-Bundles (zdf.de, ardmediathek.de, arte.tv), öffentliche OIDC-Discovery-Dokumente. Kein Login, keine Konten, keine Tokens. Alles, was ein echtes Konto braucht, ist als "ungeprüft" markiert.

## ARD
- Konto: ARD-Konto (accounts.ard.de, "MeinARD"; auch als accounts.ard-zdf.de erreichbar). Altersfreigabe: einmalige Ausweisprüfung (Personalausweis/Pass/Aufenthaltstitel, MRZ-Daten), danach Jugendschutz-PIN. Player kennt `ERROR_PLAYBACK_MATURITY_LOGIN_16/_18` ("Anmelden und Alter bestätigen") und kündigt damit auch FSK 18 als freischaltbar an (ZDF: nur FSK 16, ältere Pressequellen widersprüchlich).
- Auth: OIDC-Discovery `https://accounts.ard.de/.well-known/openid-configuration` (Issuer `securetoken.google.com/ardmt-prod`, also Firebase/Identity Platform dahinter). Token-Endpoint nur `client_secret_basic/post`, kein PKCE angegeben, Client-ID der Mediathek `mt` (Login-URL `accounts.ard.de/?clientId=mt&redirect_uri=...`). Eigene OIDC-App-Registrierung: nicht öffentlich, eigener Client mit Secret wäre nötig, daher Code+PKCE selbst nicht machbar.
- Webflow: Login bei accounts.ard.de, Rücksprung auf ardmediathek.de; Seite holt `GET https://sso.ardmediathek.de/sso/token` (Cookies, `credentials: include`) -> `customToken` -> Firebase `signInWithCustomToken` (apiKey öffentlich in der Seite, Projekt `ardmt-prod`) -> Firebase-idToken (ca. 1 h, Refresh über Firebase-Refresh-Token).
- Stream-Abruf: personalisierte Page-Gateway-Anfragen tragen Header `X-Authorization: Bearer <idToken>` (api.ardmediathek.de/page-gateway, accounts.ard.de/users). Das Player-`mediaCollection.meta.maturityContentRating.isBlocked` kommt vom Server; ob es mit Token + PIN auf false geht und ob zusätzlich PIN-Nachweis nötig ist: NUR MIT ECHTEM KONTO PRÜFBAR.

## ZDF
- Konto: kostenloses "Mein ZDF"-Konto; Altersfreigabe nur auf der Website (Einstellungen > Persönliche Daten): Mindestalter 16, Ausweis-Prüfung (Land, Dokumenttyp, Zeichen aus Bild), 4-stellige PIN. Schaltet nur FSK 16 frei (18 bleibt 23-6 Uhr). PIN muss vor JEDEM jugendgeschützten Video eingegeben werden. ARD-Konto kann im ZDF genutzt werden (`goToArdLogin`: accounts.ard.de/oidc/authorize, `response_type=code`, scope `openid nickname`, Rückgabe-Code wird gegen `api.zdf.de/identity/thirdparty/ard/login` getauscht), aber ARD-Konten haben dort `isArdAccount` und die Altersprüfung läuft separat.
- Auth: kein OIDC. Eigene Identity-API `https://api.zdf.de/identity` (u. a. `POST /login` form, `/logout`, `GET /fsk/verification`, `POST /fsk/pin` (PIN prüfen), `PUT /fsk/pin`, `/userinfo`, `/device/auth-sessions/{id}/authorize`). Sitzungstoken im localStorage (`zdf_user_token`), Header `Authorization: Bearer <token>`. Lebensdauer/Refresh unbekannt. Direktabruf ohne Token: HTTP 403.
- Die Seite blendet FSK-Modals nach `verifiedAge` des Users (>= nötige FSK) und lässt PIN eingeben, dann `unlockUrl`. Wie der PIN-Nachweis am Stream-Abruf (api.zdf.de, Token-Header) ankommt: NUR MIT ECHTEM KONTO PRÜFBAR.

## arte
- Konto: MeinARTE-Account (Keycloak `https://id.arte.tv/auth/realms/myarte-prod`). Einstellungen: "Bestätigen Sie Ihr Alter, um jederzeit auf Programme mit FSK 16 und FSK 18 zuzugreifen" (Anbieter Yoti, laut Fehlertext `yotiServiceDown`). Beide Stufen freischaltbar, keine PIN erkennbar.
- Auth: OIDC öffentlich, Discovery vorhanden: Authorization Code, PKCE (S256), Device Code, refresh_token. Client-IDs der Web-App nicht im HTML (im JS-Bundle/NextAuth-Umfeld nicht ausgewertet). SSO-API `https://api.arte.tv/api/sso/v3` (öffentliche API-Keys im HTML), Player-API `api.arte.tv/api/player/v2`; Token vermutlich als Bearer. Ungeprüft.
- Device-Code-Flow existiert (TV-Login "Anmeldecode") und wäre für die App ideal, braucht aber eine registrierte Client-ID (ungeklärt, ob die der TV-App nutzbar/zulässig ist).

## Desktop-Weg (Electron)
Eigenes BrowserWindow mit `partition: 'persist:login-<sender>'`, nodeIntegration aus, contextIsolation an; Nutzer meldet sich direkt bei Anbieter an (Passwort/Captcha/Ausweisprüfung nur dort). Danach in Main per `session.cookies.get` bzw. `executeJavaScript`/preload Token auslesen (ARD: `sso/token` aus der Partition abrufen, Firebase-REST mit öffentlichem apiKey; ZDF: `zdf_user_token` aus localStorage der Partition; arte: Keycloak-Cookies bzw. Token). Requests im Main mit Header (ARD `X-Authorization`, ZDF/arte `Authorization`). Stolpersteine: Google-OAuth/Social-Login in Embedded-Webviews oft blockiert, Captcha/Bot-Schutz, evtl. UA-Prüfung (Castlabs-Chromium-UA), Firebase-Token-Refresh, ZDF-PIN je Wiedergabe (App müsste PIN pro Video abfragen und nicht speichern, oder PIN im safeStorage ablegen).

## Recht/ToS (kurz)
Konten sind persönlich, Nutzungsbedingungen verbieten meist automatisierte Zugriffe/Weitergabe; Jugendschutz-Umgehung: nur der echte, verifizierte Nutzer darf freischalten, App darf keine Freigaben fälschen und PIN nicht umgehen. Altersverifikation-Schwächen (Berichte über MRZ-Fakes) nicht ausnutzen. Downloads nur privat. Anbieter-Zustimmung zur Token-Nutzung außerhalb der Webseiten ist nicht gegeben (Grauzone). Empfehlung: Hinweis in den Einstellungen, keine Weitergabe von Tokens.

## Empfehlung
| Sender | Machbar | Aufwand | Bemerkung |
|---|---|---|---|
| arte | wahrscheinlich ja | M | Standard-OIDC, Client-ID/Redirect nötig, beide FSK-Stufen |
| ARD | unklar bis ja | M-L | Firebase-Kette über SSO-Cookie, PIN-Mechanik offen |
| ZDF | unklar | L | proprietäre API, PIN je Video, nur FSK 16 |

Architektur: `lib/mediathek/auth/{index,ard,zdf,arte,store}.js`; Login-Fenster pro Sender (eigene Partition), Tokens/Refresh nur verschlüsselt via `safeStorage` (Passwort nie), `getAuthHeaders(sender)` für http.js, Status (angemeldet/Alter bestätigt/abgelaufen) per IPC; UI Einstellungen > Mediatheken > Konten mit Anmelden/Abmelden (löscht Partition). Reihenfolge: arte zuerst, dann ARD, ZDF zuletzt.

## Testplan (nur User mit Konto)
1. Je Sender Konto + Altersfreigabe beim Anbieter abschließen.
2. Login im App-Fenster; Captcha/Social-Login ok?
3. Gesperrten FSK-16-Inhalt tagsüber auflösen: kommen Streams im JSON (ARD `mediaCollection`, ZDF `formitaeten`, arte `streams`)?
4. Wirkt PIN pro Abruf (ZDF/ARD)? Wo geht sie ein?
5. Token-Lebensdauer: nach 1 h/24 h erneut abrufen; Refresh prüfen.
6. FSK 18 testen (arte/ARD).
7. Abmelden leert Partition; Offline-Download mit gespeichertem Token.
