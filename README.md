# PDF-Vergleichstool

Lokale Web-Anwendung, die eine Test-XML-Datei an einen konfigurierbaren Endpoint schickt,
das zurückgelieferte PDF anzeigt und es Seite für Seite mit einer Referenz-PDF vergleicht.
Abweichungen werden rot markiert.

Umgesetzte Spezifikation: [`docs/spec.md`](docs/spec.md)

---

## Schnellstart unter Windows (NFR4)

1. [Node.js 20 oder neuer](https://nodejs.org/) installieren (einmalig).
2. Diesen Ordner auf den Rechner kopieren.
3. **Doppelklick auf `start.bat`.**

`start.bat` erledigt alles Weitere:

- prüft, ob Node.js vorhanden ist,
- führt beim ersten Start `npm install` aus,
- baut das Frontend (`npm run build`),
- startet den lokalen Server auf <http://127.0.0.1:3000>,
- öffnet die Anwendung im Standardbrowser.

Beenden: Konsolenfenster schließen oder `Strg+C`.

Für eine Verknüpfung auf dem Desktop: Rechtsklick auf `start.bat` → *Senden an* → *Desktop (Verknüpfung erstellen)*.

### Port oder Host ändern

```bat
set SPAC_PORT=8080
start.bat
```

## Manuell starten (auch macOS/Linux)

```bash
npm install
npm run build     # baut das Frontend nach public/
npm start         # startet den Server (baut vorher automatisch)
npm test          # Testsuite
```

---

## Bedienung

| Feld | Bedeutung |
| --- | --- |
| **Test-XML-Datei** | Lokale `.xml`-Datei. Ihr Inhalt (ohne XML-Deklaration) bildet den Hauptteil des POST-Bodys. |
| **Referenz-PDF-Datei** | Lokale `.pdf`-Datei, gegen die verglichen wird. |
| **Ziel-URL** | Endpoint, der das PDF erzeugt, z. B. `http://server:8080/generate`. |
| **Vorlagepfad** | Freier String, wird als erste Zeile des POST-Bodys gesendet. |

- **Vergleich generieren** – sendet den POST-Request, zeigt das erzeugte PDF und den Vergleich an.
- **Refresh** – wiederholt denselben POST-Aufruf mit den aktuell eingetragenen Werten und
  aktualisiert Ergebnis und Markierungen (z. B. nachdem die Vorlage auf dem Server geändert wurde).
- **Generiertes PDF herunterladen** – speichert die Antwort als Datei.

Ziel-URL und Vorlagepfad werden im Browser (`localStorage`) gespeichert und stehen beim
nächsten Start wieder zur Verfügung (NFR3).

---

## Architektur

```
start.bat                 Windows-Starter (Server + Browser)
scripts/
  build.mjs               Frontend-Build (esbuild) nach public/
  open-browser.cmd        öffnet den Standardbrowser (von start.bat aufgerufen)
src/server/
  index.js                Server-Start
  app.js                  Express-App und API-Endpunkte
  lib/buildPostBody.js    Aufbau des POST-Bodys (FR3)
  lib/postClient.js       POST-Aufruf an die Ziel-URL (FR2/FR4)
  lib/pdfText.js          Text- und Positionsextraktion via pdf.js
  lib/diff.js             Wort-Diff (LCS)
  lib/comparePdfs.js      seitenweiser Vergleich + Markierungsboxen (FR5/FR6)
  lib/validate.js         Eingabe- und PDF-Prüfungen (NFR2)
  lib/store.js            In-Memory-Ablage der PDFs
src/client/               Oberfläche (HTML/CSS/JS, pdf.js-Anzeige)
test/                     automatisierte Tests zu FR1–FR8 und den NFRs
```

Warum ein Server-Backend statt reinem Browser-JavaScript? Der Browser dürfte den fremden
Endpoint wegen CORS in der Regel nicht direkt aufrufen. Der lokale Server leitet den Request
weiter und übernimmt zugleich das Parsen der PDFs.

### API

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `POST` | `/api/reference` | Referenz-PDF hochladen (roher Body, `Content-Type: application/pdf`) |
| `POST` | `/api/generate` | POST an die Ziel-URL ausführen, Ergebnis vergleichen |
| `GET` | `/api/pdf/:id` | gespeichertes PDF ausliefern (`?download=1` als Datei) |
| `GET` | `/api/config` | aktive Einstellungen (Content-Type, Timeout, Diff-Methode) |
| `GET` | `/api/health` | Statusabfrage |

---

## Entscheidungen zu den offenen Klärungspunkten der Spec

Die Spec lässt vier Punkte offen. Sie wurden wie folgt entschieden – jede Annahme ist so
gewählt, dass sie sich mit wenig Aufwand ändern lässt.

### 1. Tech-Stack: Node.js + Express, Frontend in Vanilla-JavaScript

Gewählt wurde der in der Spec vorgeschlagene Node-Weg.

- Nur zwei Laufzeit-Abhängigkeiten: `express` und `pdfjs-dist`.
- **Keine nativen Module** (kein `canvas`, kein ImageMagick, kein Poppler). Das ist unter
  Windows der entscheidende Punkt: `npm install` braucht keine Build-Tools und läuft in Sekunden.
- Das Frontend wird mit `esbuild` gebündelt; pdf.js-Worker und Standardschriften liegen
  lokal unter `public/`. Es wird keine Ressource aus dem Internet nachgeladen (NFR1).

### 2. Content-Type des POST-Requests: `text/plain; charset=utf-8`

Der Body ist laut FR3 reiner Text (Vorlagepfad + Leerzeile + XML) und damit kein
wohlgeformtes XML-Dokument – `application/xml` wäre sachlich falsch, `multipart/form-data`
würde die vorgegebene Zeilenstruktur zerstören. Gesendet wird zusätzlich
`Accept: application/pdf, */*`.

Umstellen ohne Codeänderung, falls der Zielendpoint etwas anderes verlangt:

```bat
set SPAC_POST_CONTENT_TYPE=application/xml
start.bat
```

Ergänzende Annahmen zum Body:

- Zeilenenden werden auf `\n` normalisiert (CRLF-Dateien werden also umgesetzt).
- Entfernt wird die erste Zeile **nur dann**, wenn es sich tatsächlich um eine XML-Deklaration
  (`<?xml … ?>`) handelt. Fehlt sie, bleibt der Inhalt vollständig erhalten – so geht bei
  Dateien ohne Deklaration keine Nutzdatenzeile verloren.
- Ein UTF-8-BOM am Dateianfang wird entfernt.

### 3. PDF-Diff-Methode: Text-Extraktion mit Positionsangaben

Verglichen wird **seitenweise auf Wortebene** (Diff über die längste gemeinsame Teilfolge).
Zu jedem abweichenden Wort liefert pdf.js Position und Größe; daraus entstehen die roten
Markierungsboxen, die in der Oberfläche über die gerenderte Seite gelegt werden.

Begründung gegenüber einem Pixel-Vergleich:

| | Text-Diff (gewählt) | Pixel-Diff |
| --- | --- | --- |
| Abhängigkeiten | keine nativen Module | Rendering-Bibliothek nötig (unter Windows aufwendig) |
| Aussage | *welches Wort* sich geändert hat | *welche Fläche* anders aussieht |
| Störanfälligkeit | unempfindlich gegen Anti-Aliasing/Renderer-Versionen | meldet auch minimale Rendering-Unterschiede |
| Blinde Flecken | rein grafische Unterschiede (Logos, Linien, Farben) | – |

**Bekannte Grenze:** Änderungen, die keinen Text betreffen (Bilder, Rahmen, Schriftart, Farbe),
werden nicht erkannt. Ebenso liefern rein gescannte PDFs ohne Textebene keinen Vergleich – in
dem Fall meldet die Anwendung 0 erkannte Wörter. Sollte das relevant werden, ist ein
zusätzlicher Pixel-Vergleich als zweite Diff-Methode nachrüstbar (Schnittstelle:
`src/server/lib/comparePdfs.js`, Feld `method` im Ergebnis).

Die Wortposition innerhalb eines Textblocks schätzt die Anwendung über gewichtete
Zeichenbreiten, da pdf.js nur die Gesamtbreite eines Blocks liefert. Die Markierung sitzt
dadurch typischerweise auf 1–3 Punkt genau über dem betroffenen Wort.

### 4. Validierung „Vorlagepfad": freier String, nur auf „nicht leer" geprüft

Der Wert wird **nicht** gegen das Dateisystem geprüft. Grund: Der Pfad wird vom
Zielservice interpretiert, der auf einem anderen Rechner laufen kann – eine lokale Prüfung
würde gültige Eingaben fälschlich ablehnen. Geprüft wird nur, dass das Feld nicht leer ist;
führende/abschließende Leerzeichen werden entfernt und nur die erste Zeile verwendet, damit
die Zeilenstruktur des Bodys aus FR3 garantiert eingehalten wird.

---

## Weitere Festlegungen

- **Speicherung der PDFs:** im Arbeitsspeicher des Servers (die letzten 20 Dokumente).
  Nach einem Serverneustart muss die Referenz-PDF erneut ausgewählt werden; die Anwendung
  weist mit einer klaren Meldung darauf hin. Es werden keine Dateien auf die Platte geschrieben.
- **Bindung an localhost:** Der Server lauscht auf `127.0.0.1` und ist damit nicht aus dem
  Netz erreichbar. Über `SPAC_HOST` änderbar.
- **Zeitlimit** für den POST-Aufruf: 120 Sekunden (`SPAC_POST_TIMEOUT_MS`).
- **Maximale Dateigröße:** 75 MB (`SPAC_MAX_UPLOAD`).

### Umgebungsvariablen

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `SPAC_PORT` | `3000` | Port des lokalen Servers |
| `SPAC_HOST` | `127.0.0.1` | Netzwerkadresse |
| `SPAC_POST_CONTENT_TYPE` | `text/plain; charset=utf-8` | Content-Type des POST-Requests |
| `SPAC_POST_TIMEOUT_MS` | `120000` | Zeitlimit für den Zielservice |
| `SPAC_MAX_UPLOAD` | `75mb` | maximale Größe von Upload/Antwort |

---

## Tests

```bash
npm test
```

Die Suite nutzt den Node-eigenen Testrunner (keine zusätzliche Test-Bibliothek). Für die
Tests werden PDFs zur Laufzeit mit `pdfkit` erzeugt und ein Mock-Zielservice gestartet – es
sind keine Binärdateien im Repository nötig und es besteht keine Netzwerkabhängigkeit.

| Anforderung | Testdatei |
| --- | --- |
| FR1 Eingabemaske mit vier Feldern | `test/fr1-eingabemaske.test.js` |
| FR2 POST-Request an die Ziel-URL | `test/fr2-fr3-post.test.js` |
| FR3 Aufbau des POST-Bodys | `test/fr2-fr3-post.test.js` |
| FR4 PDF-Response anzeigen/speichern | `test/fr4-pdf-response.test.js` |
| FR5 seitenweiser Vergleich | `test/fr5-vergleich.test.js` |
| FR6 farbliche Hervorhebung | `test/fr6-hervorhebung.test.js` |
| FR7 Refresh-Button | `test/fr7-refresh.test.js` |
| FR8 Start unter Windows | `test/fr8-windows-start.test.js` |
| NFR1–NFR3 Fehlerbehandlung, Offline-Betrieb, Persistenz | `test/nfr-fehlerbehandlung.test.js`, `test/fr7-refresh.test.js`, `test/fr8-windows-start.test.js` |

---

## Fehlermeldungen (NFR2)

Alle Fehler erscheinen als roter Kasten oberhalb des Ergebnisses, u. a.:

| Situation | Meldung |
| --- | --- |
| URL nicht erreichbar | „Die URL … ist nicht erreichbar (ECONNREFUSED). Bitte URL, Netzwerk und ob der Zielservice läuft prüfen." |
| Zielservice antwortet mit Fehler | „Der Zielservice hat mit HTTP 500 geantwortet. Meldung: …" |
| Antwort ist kein PDF | „Die Antwort des Zielservice ist kein gültiges PDF (Content-Type: text/html). Anfang der Antwort: …" |
| Zeitüberschreitung | „Zeitüberschreitung: … hat innerhalb von 120 Sekunden nicht geantwortet." |
| falsche Dateiauswahl | „… ist keine .pdf-Datei. Bitte eine PDF-Datei auswählen." |
| beschädigte Referenz-PDF | „Das Referenz-PDF konnte nicht gelesen werden: … Möglicherweise ist die Datei beschädigt oder passwortgeschützt." |

Schlägt nur der Vergleich fehl, bleibt das generierte PDF trotzdem sicht- und herunterladbar.
