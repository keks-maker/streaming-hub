# ARD: Altersfreigabe und PIN (Notizen, lokal)

Stand 21.10.2026, aus den öffentlichen Bundles von www.ardmediathek.de (clientApp, ardplayer; ohne Login).

## Ergebnis
- Es gibt im Web-Client KEINE Jugendschutz-PIN für FSK-Freigabe. Die einzige PIN im Client ist die **Kinder-PIN** (Profilwechsel
  aus Kinderprofil: `CHILD_PROFILE_LEAVING_PIN`, Route `kinder-pin`, Claim `pin` am Profil-Token). Sie hat mit FSK nichts zu tun.
- FSK-Sperre: Der Player prüft `mediaCollection.meta.maturityContentRating.isBlocked` (Server entscheidet). `age === 18` ->
  `ERROR_PLAYBACK_MATURITY_(LOGIN_)18` ("ab 23 Uhr"), sonst `..._16` ("ab 22 Uhr"). Mit `playerConfig.web.enableMaturityLogin`
  zeigt der Player "Anmelden und Alter bestätigen" (Event `Player.MATURITY_LOGIN`). Das ist Login + Altersfreigabe
  (Account-Seite `accounts.ard.de/.../altersfreigabe`, einmalige Ausweisprüfung), keine PIN-Abfrage am Video.
- Felder `blockedByFsk` kommt in den Bundles nicht vor. Teaser tragen `maturityContentRating` (-> `maturityRating`).
- Personalisierte Abrufe im Client (`useFetch` mit Option `personalized`): Header `X-Authorization: Bearer <Firebase-idToken>`
  UND Query-Parameter `userId=<Firebase-uid>` (ohne personalized wird `userId` entfernt). Bei Kinderprofilen zusätzlich
  `age=<age_rating>`. Die App sendete bisher nur den Header; `userId` fehlte. Das ist der einzige belegte Unterschied.
- Nicht geklärt (nur mit Konto prüfbar): ob der Item-Abruf serverseitig mit Header + `userId` `isBlocked=false` liefert,
  und ob das Konto die Altersfreigabe erledigt haben muss. Deshalb Diagnose-Aufzeichnung (Einstellungen > Konten > ARD).

## Umsetzung
- Kein PIN-Dialog (kein belegter Mechanismus). `pinBinding` bleibt null.
- Wiederholungsabruf gesperrter Beiträge hängt `userId` (aus dem idToken-Claim `user_id`/`sub`) an api.ardmediathek.de an.
- Diagnose-Aufzeichnung liefert die fehlenden Fakten (Ablauf, Feldnamen, FSK-Felder), ohne Werte/Token.
