# FotoVibe

Private Party-Fotogalerie für etwa 100 Gäste. Deutschsprachige Oberfläche,
gemeinsamer Party-Code, zufällige Foto-Aufgaben, native Handykamera und explizite
Upload-Bestätigung.

## Infrastruktur

- Projekt: `project-8b626ca4-30b1-415b-84b`
- Cloud Run: `europe-west1` (Belgien), `fotovibe`, 1 vCPU / 1 GiB,
  0–2 Instanzen, Concurrency 4
- Foto-Bucket: `gs://fotovibe-520703150508-photos`
- Aufgaben: Firestore Native, benannte Datenbank `fotovibe` in Frankfurt;
  Dokumente unter `tasks/<schlüssel>` mit `text` und `enabled`
- Secret: `fotovibe-auth` (Party-Code, Sitzungsschlüssel und Admin-Geräte-IDs;
  Replikation Frankfurt)
- Laufzeitidentität: `fotovibe-runtime`, Objekt-Erstellung/-Lesen nur im Foto-Bucket
  sowie Firestore-Zugriff zum Lesen und Verwalten von Foto-Aufgaben und Zugriff
  auf das Auth-Secret. Keine Löschrechte im Foto-Bucket, keine Schlüsseldateien.
- Build-Identität: `fotovibe-build`, dokumentierte Rolle `roles/run.builder`.
- Cloud Build und Artifact Registry werden nur für Builds/Image-Ablage benötigt.
  Quellarchive ab sieben Tagen werden entfernt; in Artifact Registry bleiben
  mindestens die drei jüngsten Container-Versionen erhalten.

Foto-Bucket und Secret liegen in Frankfurt (`europe-west3`). Der Dienst verarbeitet
die Bilder in Belgien, weil direkte Cloud-Run-Domain-Mappings in Frankfurt nicht
angeboten werden. Das ist keine Zusage, dass sämtliche GCP-Kontroll-, Support- oder
Abrechnungsdaten ausschließlich in diesen Regionen verarbeitet werden.

## Lokal starten

Benötigt: Python 3.12, uv, Node.js 24+ und npm. Node wird ausschließlich zum
Einbinden des HEIC-Decoders benötigt, nicht zur Laufzeit des Servers.

```sh
env -u UV_DEFAULT_INDEX uv sync --frozen
npm ci --ignore-scripts
npm run build
make run
```

Öffne `http://127.0.0.1:8080`. Der Test-Code ist `1234` (auch mit Leerzeichen
als `1 2 3 4` akzeptiert) und funktioniert ebenfalls in der bereitgestellten
Website. Lokale Fotos liegen unter `.local/photos`. Der Entwicklungsmodus
verwendet keine GCP-Ressourcen und ungesicherte lokale Cookies; niemals öffentlich
bereitstellen. Der produktive Container startet ohne Auth-Secret nicht.

`make run` beendet vor dem Start einen bereits laufenden Prozess auf `PORT`
(standardmäßig `8080`) und aktiviert danach den Entwicklungsserver mit Hot Reload.
Für einen anderen Port: `make run PORT=8081`. Beenden mit `Ctrl-C`.

Der Entwicklungsserver beobachtet Python, HTML, CSS, JavaScript und SVG. Nach
einer Änderung startet er das lokale Backend neu; eine bereits geöffnete Seite
lädt sich automatisch neu. Der direkte Aufruf bleibt ebenfalls möglich:
`env -u UV_DEFAULT_INDEX uv run --frozen python scripts/dev.py --port 8081`.

## Reproduzierbare Browser- und Gerätesimulation

Die Browser-Tests sind ausschließlich Entwicklungswerkzeuge. Playwright steht in
`devDependencies` und wird nicht in die ausgelieferte App eingebaut. Nach einem
frischen Checkout reicht einmalig:

```sh
npm run setup:tests
```

Das Setup synchronisiert die Python-Umgebung aus `uv.lock`, installiert die
Node-Abhängigkeiten reproduzierbar aus `package-lock.json`, baut den lokalen
HEIC-Decoder und lädt die Playwright-Browser Chromium, Firefox und WebKit. Danach
startet:

```sh
npm run test:e2e       # Desktop, Pixel-/Android-Viewport, iPhone-WebKit und TV-Größe
npm run test:e2e:ui    # Interaktive Playwright-Oberfläche
```

Die Chromium-Profile verwenden dabei eine deterministische Fake-Webcam. So kann
der Kameraablauf einschließlich des Desktop-Display-Blitz-Buttons ohne angeschlossene
Kamera geprüft werden; die WebKit-/Firefox-Profile bleiben echte Browser-Layouttests.

Alternativ stehen die Make-Ziele `make setup-tests`, `make test-e2e` und
`make test-e2e-ui` zur Verfügung. Der lokale Server wird für die Tests automatisch
gestartet und nach dem Testlauf beendet. Für eine bereits laufende oder deployte
Umgebung kann `PLAYWRIGHT_BASE_URL=https://… npm run test:e2e` verwendet werden.

Die Playwright-Profile prüfen Browser-Layout und Navigation, ersetzen aber keine
echte Kamera-Hardware. Für native Simulatoren meldet das Setup den lokalen Status:

- Auf macOS müssen Xcode und die gewünschten iOS-/tvOS-Runtimes einmalig über den
  Mac App Store bzw. Xcode installiert werden.
- Für Android-Handy und Android TV/Google TV müssen Android Studio, SDK,
  Emulator und mindestens ein AVD einmalig eingerichtet werden.

Diese Simulator-Runtimes sind große, hostabhängige Betriebssystem-Images und
werden bewusst nicht als npm- oder App-Dependency gebündelt. Kamera, Display-
Flash, Safari-Vollbild und gerätespezifische Browser-Eigenheiten sollten vor dem
Release zusätzlich auf einem echten iPhone und dem vorgesehenen TV-Gerät geprüft
werden.

## Deployment und erneutes Deployment

```sh
make deploy
```

Das Skript aktiviert die APIs, erstellt fehlende Ressourcen, legt die benannte
Firestore-Datenbank an und ergänzt darin fehlende Beispielaufgaben. Anschließend
deployt es den Quellcode und richtet die Cloud-Run-Mappings und Cloud-DNS-Einträge
für `180-foto.com` und `www.180-foto.com` ein. Beim ersten Lauf kann die Ausstellung
der Google-verwalteten HTTPS-Zertifikate nach dem Deployment noch einige Zeit dauern.
Bestehende Fotos und der Party-Code bleiben erhalten. Alle
projektbezogenen CLI-Aufrufe verwenden explizit das obige Projekt und ändern
keine globale gcloud-Konfiguration. Bei neuen IAM-Zuweisungen kann ein erster
Build wegen verzögerter Berechtigungsübernahme fehlschlagen; nach einigen Minuten
denselben Befehl wiederholen. Keine zusätzlichen pauschalen Editor-Rechte vergeben.

Der Build verwendet das Dockerfile und die Lockfiles. `.gcloudignore` und
`.dockerignore` schließen lokale Daten, Testbilder und Secrets aus. Das
Deployment bricht vor dem Cloud Build ab, falls eine lokale Paket-Proxy-URL in
den Build-Dateien steht und aus der Google-Cloud-Umgebung nicht erreichbar wäre.
Die erzeugte URL steht nach Erfolg in `.local/deployment.json`.

```sh
gcloud run services describe fotovibe \
  --project=project-8b626ca4-30b1-415b-84b --region=europe-west1 \
  --format='value(status.url)'
```

Upload: `https://180-foto.com`, Galerie: `https://180-foto.com/gallery`.
Das gemeinsame Fotobuch ist unter `https://180-foto.com/play` erreichbar. Dort
werden vier Bilder als wechselnde Doppelseiten gezeigt; mit
`?autoplay=1` startet der Wechsel automatisch. Neuere Uploads erhalten einen
deutlichen Gewichtungsvorsprung, ältere Fotos bleiben weiterhin im Pool. Eine
Seite vermeidet kurze Wiederholungen, damit eine kleine Party-Galerie trotzdem
lebendig bleibt.
Der feste Test-Code `1234` greift dort auf dieselbe private Fotoablage und Galerie
wie der reguläre Party-Code zu. Er ist leicht zu erraten und sollte nach Abschluss
der Tests wieder aus dem Auth-Secret entfernt werden.
Für die Kamera auf dem Handy die HTTPS-Adresse in Safari bzw. Chrome öffnen,
möglichst nicht im integrierten Browser einer Messenger-App.

„Foto aufnehmen“ fordert über die Browser-Kamera-API Zugriff auf eine Kamera an
und zeigt Livebild und lokale Fotovorschau als bildschirmfüllenden Ablauf. Im
Livebild stehen Schließen, Wechsel zwischen Front- und Rückkamera sowie der
Auslöser direkt über dem Kamerabild. Nach einer Aufnahme führt Zurück unmittelbar
wieder in die Kamera; erst „Foto hochladen“ überträgt Bilddaten. Eine gezogene
Aufgabe erscheint als kompakte verschiebbare Einblendung. Sie kann aus dem Bild
geschoben oder über „Aufgabe zeigen“ wiederhergestellt werden. Das funktioniert
auch in Desktop-Browsern mit Webcam. Falls ein Browser die API nicht unterstützt
oder der Zugriff nicht möglich ist, bietet die Oberfläche zusätzlich den nativen
Kamera-/Dateidialog an. Kamerazugriff funktioniert außerhalb von `localhost` nur
über HTTPS.

## Offline-Aufnahmen

Nach einer erfolgreichen Anmeldung ist die Aufnahme auch bei vorübergehend
fehlendem Netz verfügbar. Die App lädt dafür Aufgaben vor und speichert jede
bestätigte Aufnahme zunächst unverändert in der lokalen Browser-Datenbank. Der
kleine Wolken-Button in der Kopfzeile zeigt an, ob Fotos warten, übertragen
werden oder eine Anmeldung benötigen; dort lassen sich fehlgeschlagene Einträge
erneut versuchen oder lokal löschen. Die Übertragung läuft einzeln weiter, sobald
die App wieder Netz hat oder erneut geöffnet wird. Browser mit Background Sync
können zusätzlich im Hintergrund fortsetzen.

Es werden höchstens 25 Fotos beziehungsweise 250 MiB lokal vorgemerkt und stets
20 MiB Speicherreserve freigehalten. Fotos werden erst nach einer erfolgreichen
Serverantwort gelöscht. Bei einer Abmeldung können wartende Fotos behalten oder
gelöscht werden. Ein erster Beitritt zur Party braucht weiterhin Internet.

## Foto-Aufgaben verwalten

Die zehn Ausgangsaufgaben stehen in `infra/tasks.json`. Beim Deployment werden
nur fehlende Dokumente angelegt; bereits in Firestore geänderte Texte bleiben
erhalten. Die Website liefert Aufgaben ausschließlich nach erfolgreicher Anmeldung
und berücksichtigt nur Dokumente mit `enabled=true`.

Gäste können im Aufgaben-Auswahlfenster eigene Freitext-Aufgaben hinzufügen.
Diese bleiben zunächst privat und stehen nur der Person zur Auswahl, die sie
erstellt hat. Admins können sie später veröffentlichen. Im Admin-Panel gibt es
zusätzlich den Tab „Aufgaben“: Dort lassen sich alle vorhandenen Aufgaben
anlegen, bearbeiten oder löschen. Die Aufgaben liegen in Firestore (lokal in
`.local/tasks.json`); das Deployment richtet dafür den schreibenden
Firestore-Zugriff der Laufzeitidentität ein.

Mit der vorhandenen gcloud-Anmeldung lassen sich Aufgaben ohne neues Deployment
verwalten:

```sh
python3 scripts/manage_tasks.py list
python3 scripts/manage_tasks.py set gruppenfoto "Mach ein Foto mit vier Personen, die sich heute neu kennengelernt haben."
python3 scripts/manage_tasks.py disable gruppenfoto
```

`set` erstellt einen neuen Schlüssel oder überschreibt Text und Status eines
bestehenden Dokuments. `disable` behält den Eintrag, zeigt ihn Gästen aber nicht
mehr an. Schlüssel bestehen aus Kleinbuchstaben, Ziffern und Bindestrichen; Texte
sind auf 500 Zeichen begrenzt.

Wird ein Foto über eine Aufgabe aufgenommen, erhält der Browser beim Vorladen ein
signiertes Aufgaben-Snapshot-Token. Dieses bindet Aufgabenschlüssel und den damals
sichtbaren Wortlaut, sodass eine offline gezogene Aufgabe auch nach einer späteren
Änderung oder Deaktivierung gültig bleibt. Der Foto-Datensatz enthält weiterhin
nur Schlüssel und Text; das Token wird nie veröffentlicht. Ältere Clients dürfen
weiterhin den Aufgabenschlüssel direkt senden.

## Party-Code anzeigen oder wechseln

Zusätzlich zum manuellen Party-Code erzeugt das Deployment einen eigenen,
zufälligen Einladungslink. Er steht nach dem Deployment als `invite_url` in der
lokalen Datei `.local/deployment.json` und wird am Ende von `make deploy`
ausgegeben. Admins sehen denselben Link im Admin-Panel und können ihn dort direkt
kopieren. Gäste, die diesen Link öffnen, landen nach der serverseitigen Prüfung
direkt bei der Namenseingabe; der Party-Code selbst ist weder Bestandteil der URL
noch für den Browser lesbar.

Der lange URL-Token ist ein separater Zugangsschlüssel: Er lässt den Party-Code
nicht erkennen, gewährt seinem Besitzer aber trotzdem Zugang zur Party und darf
daher nur mit Gästen geteilt werden. Nach dem Aufruf wird er sofort aus der
Adresszeile entfernt und in eine auf 15 Minuten begrenzte, signierte
`HttpOnly`-Freigabe umgewandelt. Ungültige Links liefern nur einen 404-Fehler.
`make deploy-rotate-code` ersetzt sowohl Party-Code als auch Einladungs-Token und
macht alte Links und Sitzungen ungültig.

Code der zuletzt erstellten Secret-Version anzeigen (nicht öffentlich teilen):

```sh
gcloud secrets versions access latest --secret=fotovibe-auth \
  --project=project-8b626ca4-30b1-415b-84b | \
  python3 -c 'import json,sys; print(json.load(sys.stdin)["party_code"])'
```

Das Deployment bindet eine konkrete Secret-Version. Eine manuell hinzugefügte
Version wird erst mit einem erneuten Deployment aktiv. Nach einem gescheiterten
Code-Wechsel kann `latest` bereits den neuen, noch nicht aktiven Code enthalten.
Die aktive Version steht in der Cloud-Run-Konfiguration und nach erfolgreichem
Deployment in `.local/deployment.json`.

```sh
make deploy-rotate-code
```

Erzeugt einen neuen zehnstelligen Code, Einladungs-Token und Sitzungsschlüssel
und deployt sie. Damit müssen sich alle Gäste erneut anmelden. Fotos bleiben
erhalten.
Eine private lokale Kopie neu erzeugter Secrets liegt in `.local/auth.json`
(Dateirechte `0600`, nicht für Git/Build vorgesehen).

## Admins und ausgeblendete Fotos

Die in `DEFAULT_ADMIN_DEVICE_IDS` und `ADMIN_DEVICE_IDS` hinterlegten
Ausgangs-Admins stehen als `admin_device_ids` im Auth-Secret. Die App vergleicht
sie mit der party-spezifischen Gerätekennung des Browsers; die Werte sind keine
Namen und werden serverseitig geprüft. Änderungen an dieser Startliste werden
weiterhin mit `make deploy` ausgerollt. Zusätzlich können Admins im Panel Gäste
zu Admins machen oder Adminrechte entziehen. Diese Änderungen werden als
unveränderliche Rollenereignisse unter `admin_roles/<GERÄTE-HASH>/` gespeichert
und gelten sofort, ohne dass dafür ein neues Deployment nötig ist. Die letzte
Rollenentscheidung überschreibt die Startliste; die App verhindert, dass der
letzte verbleibende Admin entfernt wird.

Admins sehen im Profilmenü das Admin-Panel. Es zeigt registrierte Gäste,
deren Nutzer- und Geräte-ID, Upload-Zähler sowie kleine Vorschaubilder ihrer
Fotos. „Aus Galerie entfernen“ schreibt nur eine unveränderliche
Ausblend-Markierung unter `hidden/<UUID>.json`. Original, Anzeigeversion,
Thumbnail und veröffentlichter Bilddatensatz bleiben im Bucket erhalten, das
Foto verschwindet aber aus Galerie und Fotobuch.

## Fotos und Datenschutz

- Der Fotobibliothek-Picker akzeptiert alle Bildtypen. JPEG bleibt im Original
  erhalten; andere vom Browser lesbare Formate sowie HEIC/HEIF werden für einen
  zuverlässigen Upload als statisches JPEG-Cover gespeichert. Serverseitig sind
  auch JPEG, PNG, WebP, HEIC/HEIF und AVIF zulässig.
- Ein Foto pro Upload, maximal 25 MiB und 64 Millionen Pixel. Keine separaten
  Videos oder RAW-Dateien. Bei Live-/Motion-Photos wird das statische Cover
  angezeigt; eingebettete Bewegungsdaten eines JPEG-Originals bleiben erhalten.
- Das Betriebssystem kann bereits vor der Übergabe Formate umwandeln oder die
  Aufnahme begrenzen.
- Übernommene JPEG-Originale werden nicht verändert. Anzeigeversion (max. 2560 px)
  und Thumbnail (max. 640 px) sind JPEGs mit korrigierter Orientierung und ohne
  EXIF/GPS.
- Übernommene JPEG-Originale können EXIF/GPS enthalten und sind für alle mit
  Party-Code downloadbar; normalisierte Cover enthalten diese Metadaten nicht.
- Der Party-Code ist ein gemeinsamer Zugang, keine persönliche Identifizierung.
  Wer ihn erhält, kann ihn weitergeben. Ersetze ihn nach Bedarf.
- Beim ersten Beitritt erzeugt der Browser eine zufällige Kennung und speichert sie
  lokal. Nach der Namenswahl kann die Website damit eine abgelaufene oder beim
  Browser-Schließen verlorene Sitzung automatisch wiederherstellen. Die Kennung
  wird nur als party-spezifischer Hash gespeichert, nicht in der Galerie gezeigt.
  Das Löschen der Website-Daten im Browser entfernt diese Wiedererkennung.
- Nutzer- und Geräte-IDs werden nicht im Profilmenü angezeigt. Sie bleiben
  zufällige, party-spezifische App-Kennungen und sind keine Hardware-, Werbe-
  oder Betriebssystem-IDs. Das Profilmenü zeigt die Zahl der von diesem Profil
  veröffentlichten Fotos.
- Neue Fotos enthalten eine Momentaufnahme des gewählten Anzeigenamens. Damit
  bleibt sichtbar, wer ein Bild hochgeladen hat, auch wenn die Person später nicht
  mehr auf die Website zugreift.

## Speicherlayout und Upload-Wiederholung

```text
photos/<UUID>/original
photos/<UUID>/display.jpg
photos/<UUID>/thumb.jpg
published/<UUID>.json
users/<PARTY-GERÄTE-HASH>.json
users/<PARTY-GERÄTE-HASH>/uploads/<FOTO-UUID>.json
admin_roles/<PARTY-GERÄTE-HASH>/<EREIGNIS-UUID>.json
```

Die Originaldatei hat einen SHA-256-Wert als Objektmetadatum. Alle Schreibvorgänge
verwenden eine GCS-Generation-Vorbedingung (`ifGenerationMatch=0`). Ein bereits
verwendeter Upload-Schlüssel mit anderem Bildinhalt wird abgewiesen.
Wenn ein Foto eine Aufgabe hat, werden Aufgaben-ID und Aufgaben-Text zusätzlich
als Objektmetadaten am Original gespeichert. Damit können auch ältere
`published`-Einträge ohne Galerieindex die Aufgabe nachträglich aus dem Bucket
auflösen. Der versionierte Datensatz und der kompakte Index bleiben die primären
Quellen; der Originaleintrag ist die robuste Rückfallebene für die laufende
Aufgabenimplementierung.
Der abschließende `published`-Datensatz macht das Foto erst nach erfolgreicher
Speicherung aller drei Dateien sichtbar. Wiederholungen nach einem Abbruch
ergänzen fehlende Objekte und erstellen keinen zweiten Galerieeintrag.
Für angemeldete Nutzer wird zusätzlich pro veröffentlichtem Foto ein unveränderliches
Upload-Ereignis gespeichert. Die Gerätekennung ist bereits durch den Party-Code
abgegrenzt. Weil der Foto-Schlüssel Teil des Objektnamens ist, erhöhen erneute
Übertragungen desselben Uploads den Wert `photos_uploaded` nicht doppelt. Profile,
die schon vor dieser Funktion bestanden, werden beim ersten Öffnen einmalig aus
den vorhandenen Foto-Autoren nachgezogen.

Der JSON-Datensatz unter `published/` ist versioniert und enthält einen
erweiterbaren `metadata`-Block. Bei Aufgaben sieht er beispielsweise so aus:

```json
{
  "schema_version": 1,
  "metadata": {
    "task": {
      "id": "gastgeber",
      "text": "Mach ein Foto mit einem der Gastgeber."
    }
  }
}
```

Der vollständige Datensatz enthält zusätzlich Foto-ID, Format, Größe, Maße und
Prüfsumme. Der `published`-Blob trägt denselben Metadatenblock kompakt codiert als
GCS-Objektmetadatum. Dadurch kann die Galerie Aufgaben zusammen mit den Fotos
auflisten, ohne für jedes Bild einen zusätzlichen Objektabruf auszuführen. Fotos
ohne Aufgabe erhalten einen leeren `metadata`-Block. Dieses Schema kann später um
weitere Metadaten ergänzt werden.

Abgebrochene, nie wiederholte Uploads können unveröffentlichte Objekte unter
`photos/` hinterlassen. Sie sind über die App nicht abrufbar, verursachen aber
Speicherkosten. Sie werden bewusst nicht automatisch gelöscht. Bei einer
späteren Bereinigung zuerst mit den IDs unter `published/` vergleichen.

## Originale exportieren

```sh
mkdir -p export
gcloud storage rsync --recursive \
  gs://fotovibe-520703150508-photos export \
  --project=project-8b626ca4-30b1-415b-84b
```

Dies sichert Originale, Vorschauen und Metadaten. Das Originalformat steht in
`published/<UUID>.json` als `extension`; die Originaldatei heißt im Bucket bewusst
`original`. Zum Öffnen eine Kopie mit der entsprechenden Endung erstellen.

## Einzelne Fotos löschen

Nur als Gastgeber über gcloud, nach Sicherung. Zuerst den Veröffentlichungsdatensatz
löschen, dann die zugehörigen Dateien. `FOTO_UUID` durch eine tatsächliche ID ersetzen.

```sh
gcloud storage rm gs://fotovibe-520703150508-photos/published/FOTO_UUID.json \
  --project=project-8b626ca4-30b1-415b-84b
gcloud storage rm 'gs://fotovibe-520703150508-photos/photos/FOTO_UUID/**' \
  --project=project-8b626ca4-30b1-415b-84b
```

Galerielisten werden maximal fünf Sekunden serverseitig zwischengespeichert.
Die Web-Galerie ruft zwölf Einträge pro Seite ab, priorisiert nur die ersten
sichtbaren Vorschaubilder und lädt weitere Seiten kurz vor dem Scroll-Ende nach.
Eine frische Galerieliste dient zugleich als kurzlebiger Veröffentlichungsnachweis,
damit nicht für jedes Vorschaubild dasselbe Manifest erneut aus GCS gelesen wird.
Bereits geöffnete Galerien können ein gelöschtes Vorschaubild bis zum Neuladen
zeigen; der geschützte Bildabruf verweigert Zugriff ohne Veröffentlichungsdatensatz.
Bereits heruntergeladene Originale lassen sich nicht zurückrufen.

## Betrieb, Kosten und Abschalten

Cloud Run verwendet anfragebasierte Abrechnung mit `min=0`. Eine geöffnete,
sichtbare Galerie fragt alle 15 Sekunden nach neuen Bildern; in einem versteckten
Tab pausiert sie. Erst ohne Anfragen kann Cloud Run auf null skalieren.
Cold Starts sind akzeptiert. 1 GiB ermöglicht die Bearbeitung großer Handyfotos,
wobei pro Instanz nur eine Konvertierung gleichzeitig läuft.

Es gibt keine garantierte Nullrechnung: Foto-/Image-/Quellcode-Speicherung,
Operationen, Firestore-Lesezugriffe, Builds und Internet-Downloads können
kostenpflichtig bleiben.
Das Maximum von zwei Instanzen ist **kein hartes Budgetlimit**. Es können zudem
vorübergehende Überhänge bei Deployments/Plattformwartung auftreten.
Rate-Limits sind pro Instanz und im Speicher (30 fehlgeschlagene Anmeldungen je
IP/Minute; 10 Upload-Versuche je Sitzung/Minute), keine globale Missbrauchsquote.

```sh
gcloud run services logs read fotovibe --limit=30 \
  --project=project-8b626ca4-30b1-415b-84b --region=europe-west1
```

Zum Stilllegen der Website ohne Fotolöschung:

```sh
gcloud run services delete fotovibe \
  --project=project-8b626ca4-30b1-415b-84b --region=europe-west1
```

Der Foto-Bucket bleibt dabei erhalten. Für vollständigen Rückbau erst exportieren
und den Export prüfen; anschließend die Fotoobjekte und den Bucket, die
Artifact-Registry-Images/das Repository `cloud-run-source-deploy`, den Source-Bucket
`run-sources-project-8b626ca4-30b1-415b-84b-europe-west1`, das Secret sowie die beiden
Service Accounts und die benannte Firestore-Datenbank `fotovibe` gezielt entfernen.
Keine fremden Projektressourcen löschen.
Es gibt absichtlich keinen automatisch ausgeführten destruktiven Rückbau.

## Tests

```sh
env -u UV_DEFAULT_INDEX uv run --frozen pytest -q
env -u UV_DEFAULT_INDEX uv run --frozen ruff check fotovibe tests scripts
node --check static/app.js
```

Der Live-Smoke-Test erstellt ausschließlich synthetische Testbilder und räumt
seine eigenen UUIDs im `finally`-Block wieder auf:

```sh
make smoke
```

Vor der Feier auf **echtem iPhone/Safari und Android/Chrome** prüfen:

1. Party-Code eingeben, Kamera starten, Zugriff erlauben oder abbrechen.
2. Aufgabe ziehen, eine andere Aufgabe wählen, die Einblendung in Kamera und
   Vorschau verschieben, aus dem Bild schieben und wieder einblenden.
3. Hoch- und Querformat im Vollbild aufnehmen, zur Kamera zurückgehen, erneut
   aufnehmen und den Upload bestätigen.
4. JPEG, HEIC/Live Photo und ein weiteres Bildformat aus der Bibliothek auswählen;
   Vorschau abwarten und prüfen, dass jeweils das statische Cover hochgeladen wird.
5. Upload, Erfolg, Galerie auf zweitem Gerät und Original-Download prüfen.
6. Schlechtes Netz/Verbindungsabbruch testen: Fehlermeldung, Wiederholung, kein Duplikat.
7. In Messenger-internen Browsern bei Problemen in Safari/Chrome wechseln.

Browsergrößen-Simulation ersetzt diese Geräteprüfung nicht.
