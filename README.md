# PDF-Vergleichstool

Lokale Web-Anwendung, die eine Test-XML-Datei an einen konfigurierbaren Endpoint schickt,
das zurückgelieferte PDF anzeigt und es Seite für Seite mit einer Referenz-PDF vergleicht.
Abweichungen werden **im generierten Dokument** rot markiert; die Referenz bleibt unmarkiert.

Umgesetzte Spezifikation: [`docs/spec.md`](docs/spec.md)

---

## Schnellstart unter Windows (NFR4)

> Ausführliche Schritt-für-Schritt-Anleitung inkl. Problembehebung:
> [`docs/INSTALLATION-Windows.md`](docs/INSTALLATION-Windows.md)

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
| **Vorlagepfad** | Freier String, wird als erste Zeile des POST-Bodys gesendet. |

Die **Ziel-URL für den POST-Aufruf** steht unter „Erweiterte Einstellungen" und ist bereits mit
`https://inspire-scaler.ccm.dev.babiel.com/rest/api/submit-job/CreateTestDocumentDl` vorbelegt –
sie muss nur bei einem anderen Ziel angepasst werden. Der geänderte Wert bleibt gespeichert (NFR3).

### Darstellung der Abweichungen

Beide Dokumente werden nebeneinander angezeigt, **markiert wird aber ausschließlich das
generierte Dokument** – die Referenz dient als unveränderter Vergleichsmaßstab. Es gibt zwei
Markierungsarten:

| Markierung | Bedeutung |
| --- | --- |
| rot gefüllt, durchgezogener Rand | Der Text steht im generierten Dokument und weicht von der Referenz ab. |
| gestrichelter Rand, ohne Füllung | Der Text steht in der Referenz und **fehlt** im generierten Dokument. |

Fehlender Text hat im generierten Dokument naturgemäß keine eigene Position. Er wird deshalb
an der Stelle markiert, an der er in der Referenz steht (bei abweichenden Seitenformaten
umgerechnet). Verschiebt sich der Text durch die fehlende Stelle, kann die gestrichelte
Markierung daher über nachfolgendem Inhalt liegen – der Tooltip nennt den konkret fehlenden
Text.

### Abweichend kodierte Sonderzeichen

PDFs kodieren Sonderzeichen nicht immer als ein Textelement. Wird ein Umlaut z. B. aus einer
anderen Schrift gesetzt, liefert die Textextraktion `Selbstst`, `ä` und
`ndige(r)` als drei Elemente – ohne Behandlung entstünde daraus
"Selbstst ä ndige(r)" und damit eine gemeldete Abweichung, obwohl der Text identisch ist.

Die Anwendung fängt das auf drei Ebenen ab:

1. **Wortteile zusammenführen** – direkt aneinander anschließende Textelemente derselben Zeile
   werden wieder zu einem Wort verbunden. Die Grenze liegt bei 0,2 em Abstand; ein echtes
   Leerzeichen ist mit 0,25–0,33 em breiter und wird daher nicht zusammengezogen.
2. **Schreibweisen vereinheitlichen** – Unicode-Normalisierung (zerlegtes "a"+Trema gilt als
   "ä"), Entfernen unsichtbarer Steuerzeichen (weiches Trennzeichen, Zero-Width-Zeichen) sowie
   Vereinheitlichen von Leerzeichen-, Bindestrich- und Anführungszeichen-Varianten.
3. **Reine Trennungsunterschiede erkennen** – ergeben mehrere Wörter zusammengesetzt denselben
   Text wie auf der Gegenseite, gilt das nicht als Abweichung. Das greift auch dort, wo die
   Zusammenführung nicht möglich war, und ebenso im Markdown-Vergleich.

Echte Unterschiede bleiben davon unberührt: Ein anderer Umlaut ("ö" statt "ä") oder ein
anderer Betrag wird weiterhin markiert.

Über dem Vergleich liegt eine Leiste mit dem Schalter **„Markierungen anzeigen"** und der
Legende zu beiden Markierungsarten. Der Schalter blendet alle Markierungen aus, ohne die
Seiten neu zu zeichnen – praktisch, um kurz das unverfälschte Dokument zu sehen. Der Zustand
bleibt wie die übrigen Eingaben erhalten.

Die Seiten werden auf die tatsächlich verfügbare Spaltenbreite gezeichnet (in Gerätepixeln,
daher scharf) und nach einer Größenänderung des Fensters neu gerendert. Zwischen den beiden
Dokumenten bleibt dadurch nur der Spaltenabstand.

### Nicht sichtbare Inhalte

PDFs enthalten oft Text, der gar nicht gezeichnet wird. Am Bildschirm ist davon nichts zu
sehen, in der Textextraktion taucht er aber auf – und würde ohne Behandlung als Abweichung
gemeldet. Erkannt und ausgenommen werden:

| Fall | Typisches Vorkommen |
| --- | --- |
| Rendermodus 3 oder 7 | OCR-Textebene unter einem Scan; Text nur als Beschnittpfad |
| Fülldeckkraft 0 | ausgeblendete Bausteine, Wasserzeichen-Reste |
| Schriftgröße 0 | Platzhalter und Steuermarken aus Vorlagensystemen |
| außerhalb des Seitenbereichs | abgeschnittene oder geparkte Inhalte |

Rendermodus, Deckkraft und Farbe stehen nur in der Operatorliste des PDFs, nicht im
extrahierten Text. Beide Quellen decken sich nicht eins zu eins: pdf.js zerlegt Textausgaben
in mehrere Elemente und lässt manches weg. Die Zuordnung sucht deshalb jedes Textelement als
**zusammenhängende Zeichenfolge** im Zeichenstrom der Operatorliste. Passt ein Element nicht
exakt, wird die Zuordnung verworfen – dann gilt sämtlicher Text als sichtbar. Lieber nichts
ausblenden als das Falsche.

Abschaltbar unter „Erweiterte Einstellungen" → *Nicht sichtbare Inhalte ignorieren*.
Das Ergebnis weist aus, wie viele Stellen betroffen waren.

**Nicht erkannt** wird Text, der von einem anderen Element verdeckt wird (etwa weiße Schrift
auf weißem Grund oder Text unter einem Bild). Das ließe sich nur durch tatsächliches Rendern
und Pixelvergleich feststellen; eine Farbheuristik würde weiße Schrift auf farbigem Kasten
fälschlich ausblenden.

### Kopf- und Fußzeile ausschließen

In Kopf- und Fußzeile stehen häufig Datum, Seitenzahl oder Aktenzeichen – Angaben, die sich
zwischen Referenz und generiertem Dokument zwangsläufig unterscheiden, ohne dass es ein Fehler
wäre. Unter „Erweiterte Einstellungen" lässt sich **Kopf- und Fußzeile ausschließen** aktivieren;
die Höhe der beiden Randbereiche ist in Millimetern einstellbar (Vorgabe je 25 mm).

Ausgeblendet wird ein Wort, dessen vertikale Mitte im oberen `Kopfzeile`-Band oder im unteren
`Fußzeile`-Band liegt – gemessen relativ zur jeweiligen Seitenhöhe, damit die Angabe auch bei
unterschiedlichen Seitenformaten passt. Ein Wert von 0 mm schaltet den jeweiligen Bereich ab
(so lässt sich z. B. nur die Fußzeile ausschließen). Der Ausschluss wirkt auf die visuelle
Ansicht **und** den Markdown-Vergleich; das Ergebnis weist aus, wie viele Wörter betroffen
waren. Der Seiteninhalt dazwischen wird unverändert verglichen.

Standardmäßig ist der Ausschluss **aus** – Kopf- und Fußzeile werden also normal mitverglichen,
bis er bewusst eingeschaltet wird.

### Vertikalen Text (seitliche Rahmenvermerke) ausschließen

Seitliche Rahmenvermerke wie Aktenzeichen oder Stempel sind meist um 90° gedreht. Dieser
vertikale Text gehört selten zum eigentlichen Dokumentinhalt, unterscheidet sich aber oft
zwischen Referenz und generiertem Dokument.

Unter „Erweiterte Einstellungen" lässt sich **Vertikalen Text ausschließen** aktivieren. Die
Anwendung erkennt die Textrichtung an der Textmatrix des PDFs (zeigt sie stärker nach
oben/unten als zur Seite, gilt der Text als vertikal) und nimmt jeglichen so gesetzten Text
vom Vergleich aus – unabhängig von seiner Position. Der Ausschluss wirkt auf die visuelle
Ansicht **und** den Markdown-Vergleich; das Ergebnis weist aus, wie viele Stellen betroffen
waren.

Standardmäßig ist die Option **aus** – vertikaler Text wird also normal mitverglichen, bis sie
bewusst eingeschaltet wird. Waagerechter Fließtext bleibt in jedem Fall unberührt.

### Checkboxen und andere Symbolzeichen

Kästchen, Haken und Pfeile stammen in PDFs aus Symbolschriften (Wingdings, ZapfDingbats,
Webdings …). Diesen Zeichen fehlt die Unicode-Zuordnung, weshalb die Textextraktion den rohen
Zeichencode liefert – aus einem Checkbox-Kästchen wird so ein `A`:

```
Referenz  : A einmalig A gelegentlich A bis zu einer Woche A 2-3 Monate
Generiert :   einmalig   gelegentlich   bis zu einer Woche   2-3 Monate
```

Enthält nur eines der Dokumente diese Zeichen, wären das lauter gemeldete Abweichungen,
obwohl der Text identisch ist. Die Anwendung **nimmt solche Zeichen vom Textvergleich aus** –
in beiden Dokumenten, damit der Vergleich symmetrisch bleibt. Das Ergebnis weist aus, wie viele
Zeichen betroffen waren.

Erkannt werden sie auf zwei Wegen: am **Schriftnamen** (Wingdings, ZapfDingbats …) und –
unabhängig davon – am **Glyph selbst**. Der Glyph-Weg greift nur, wenn alle drei Bedingungen
zutreffen: der gezeichnete Glyph weicht vom gemeldeten Textzeichen ab, das gemeldete Zeichen ist
ein einzelner Buchstabe/eine Ziffer (eben der Rückfall), und der gezeichnete Glyph liegt in einem
Symbolblock (Kästchen, Haken, Pfeile, Dingbats). So werden auch Checkboxen aus Schriften erkannt,
deren Name nicht auf der Liste steht.

Der **Private-Use-Bereich zählt bewusst nicht** als Symbol: Eingebettete Subset-Schriften – in
echten PDFs der Normalfall – bilden ganz normale Buchstaben dorthin ab. Würde man ihn mitzählen,
gälte sämtlicher Text als Symbol und der Vergleich meldete gar keine Abweichungen mehr. Als
zusätzliche Sicherung wird der Glyph-Erkennung nicht vertraut, wenn sie mehr als die Hälfte einer
Seite als Symbol einstufen würde.

Abschaltbar unter „Erweiterte Einstellungen" → *Symbolzeichen beim Textvergleich ignorieren*.
Dann zählen die Kästchen wieder als Text – sinnvoll, wenn gerade deren Vorhandensein geprüft
werden soll. Unabhängig davon bleiben die Kästchen in der **PDF-Ansicht sichtbar**; ausgenommen
sind sie nur vom Text- und Markdown-Vergleich.

### Zeichenreihenfolge im PDF

pdf.js liefert den Text in der Reihenfolge, in der das PDF ihn **zeichnet** – und die muss
nicht der Lesereihenfolge entsprechen. Formulargeneratoren setzen etwa erst alle
Checkbox-Kästchen und danach alle Beschriftungen; ein anderes Werkzeug mischt beides. Der
Inhalt ist gleich, die Reihenfolge der Textelemente nicht.

Die Anwendung sortiert die Wörter deshalb nach dem Zusammenführen in Lesereihenfolge
(zeilenweise von oben nach unten, innerhalb einer Zeile von links nach rechts). Ohne diese
Normalisierung meldete der visuelle Vergleich Abweichungen, während der Markdown-Vergleich –
der ohnehin nach Position gruppiert – nichts fand. Beide Ansichten kommen jetzt zwingend zum
selben Ergebnis.

### Reiter „Markdown-Vergleich"

Neben der PDF-Ansicht gibt es einen zweiten Reiter: Beide Dokumente werden in eine
Markdown-Textfassung übersetzt und **zeilenweise** gegenübergestellt – nützlich, um
Änderungen zu lesen, zu kopieren oder in ein Ticket zu übernehmen.

Aus dem PDF wird dabei:

- `## Seite N` als Überschrift je Seite,
- `### …` für Zeilen, deren Schrift deutlich größer ist als der Fließtext,
- `- …` für Zeilen, die mit einem Aufzählungszeichen beginnen,
- ansonsten die Textzeile, aus den Wortpositionen wieder zu Zeilen zusammengesetzt.

Die Gegenüberstellung färbt ganze Zeilen und hebt innerhalb geänderter Zeilen zusätzlich die
abweichenden **Wörter** hervor:

| Farbe | Bedeutung |
| --- | --- |
| rot (nur links) | Zeile steht nur in der Referenz |
| grün (nur rechts) | Zeile steht nur im generierten Dokument |
| gelb (beide Seiten) | Zeile wurde geändert; die abweichenden Wörter sind zusätzlich markiert |

Mit **„Nur Abweichungen anzeigen"** werden identische Zeilen ausgeblendet; über
**„Markdown herunterladen"** lässt sich die Textfassung des generierten Dokuments speichern.
Der zuletzt gewählte Reiter und der Filter bleiben erhalten.

Es handelt sich um eine Textfassung, nicht um eine originalgetreue Layout-Umwandlung:
Tabellenstrukturen, Bilder und Spaltenlayouts gehen dabei verloren – für die Prüfung der
Layouttreue bleibt der PDF-Reiter zuständig.

### Reiter „Font & Stil"

Der dritte Reiter vergleicht die **Formatierung** statt des Inhalts: Schriftart,
Schriftgröße, Fettung, Kursivstellung und Textfarbe. Er beantwortet Fälle, die der Textvergleich
naturgemäß nicht sieht – etwa wenn eine Überschrift plötzlich nicht mehr fett oder in einer
anderen Farbe gesetzt wird, der Wortlaut aber unverändert bleibt.

**Abweichungen bei gleichem Text** listet Stellen, die inhaltlich übereinstimmen, aber anders
gesetzt sind:

```
Seite 1  „Rechnung 4711"   [Schriftart] [Schriftgröße] [Fettung] [Textfarbe]
         ● Helvetica-Bold 18 pt, fett, #c00000   →   ● Helvetica 14 pt, #000080
```

Verglichen werden nur Wörter, die der Textvergleich als übereinstimmend erkannt hat – sonst
ließe sich nicht unterscheiden, ob sich der Text oder nur die Formatierung geändert hat.
Aufeinanderfolgende Wörter mit derselben Abweichung werden zu einem Eintrag zusammengefasst.

**Verwendete Schriften** stellt das Inventar beider Dokumente gegenüber: jede Kombination aus
Schriftart, -größe, -schnitt und Farbe mit der Zahl der Wörter je Dokument und dem Status
(*in beiden*, *nur in der Referenz*, *nur im generierten*, *unterschiedlich häufig*). So fällt
sofort auf, wenn eine Schrift im generierten Dokument gar nicht mehr vorkommt.

Zur Herkunft der Daten: pdf.js liefert im Textinhalt nur generische Angaben wie „sans-serif".
Die echten Schriftnamen stehen erst nach dem Auswerten der Operatorliste zur Verfügung, die
Textfarben ausschließlich dort. Lassen sich die Farben nicht zweifelsfrei den Textstellen
zuordnen – das kann bei ungewöhnlich aufgebauten PDFs vorkommen –, werden sie **nicht geraten**,
sondern vom Vergleich ausgenommen; die Oberfläche weist dann darauf hin.

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
  lib/httpHeaders.js      zusätzliche Header und cURL-Reproduktion
  lib/requestDiff.js      Vergleich mit einer aufgezeichneten Fremd-Anfrage
  lib/pdfText.js          Text- und Positionsextraktion via pdf.js
  lib/diff.js             Wort-Diff (LCS)
  lib/pdfMarkdown.js      Textfassung des PDFs als Markdown
  lib/markdownDiff.js     zeilenweiser Vergleich der Markdown-Fassungen
  lib/pdfStyle.js         Schriftart, -größe, -schnitt, Farbe und Sichtbarkeit je Textstelle
  lib/styleCompare.js     Vergleich der Formatierung + Schriftinventar
  lib/comparePdfs.js      seitenweiser Vergleich + Markierungsboxen (FR5/FR6)
  lib/validate.js         Eingabe- und PDF-Prüfungen (NFR2)
  lib/logger.js           Protokoll nach logs/spac.log (Body + Antwort bei Fehlern)
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
würde die vorgegebene Zeilenstruktur zerstören.

**Der Body wird immer als Rohtext gesendet** – exakt die Bytes aus Vorlagepfad, Leerzeile und
XML-Inhalt, ohne Multipart-Rahmen, ohne URL-Kodierung, ohne JSON-Wrapper und ohne Chunking
(es wird ein festes `Content-Length` gesetzt). Der Aufruf läuft direkt über `node:http` statt
über `fetch`, weil `fetch` ungefragt Browser-Header wie `sec-fetch-mode`, `accept-language`,
`accept-encoding` und `user-agent` ergänzt, die strikte Endpoints ablehnen können. Über die
Leitung gehen ausschließlich:

```
POST /pfad HTTP/1.1
Content-Type: text/plain; charset=utf-8
Content-Length: 42
Accept: */*
User-Agent: SPAC-PDF-Vergleichstool/1.0
Host: server:8080
Connection: keep-alive

C:\Vorlagen\rechnung.tpl

<rechnung nummer="4711">
  …
```

`Accept` ist bewusst unspezifisch (`*/*`) – eine Einschränkung auf `application/pdf` kann bei
streng verhandelnden Endpoints zu HTTP 406 führen. Der `User-Agent` wird gesetzt, weil manche
Endpoints und vorgelagerte Firewalls Anfragen ohne User-Agent abweisen.

**Eigene Header** lassen sich unter „Erweiterte Einstellungen" ergänzen – eine Zeile je Header
im Format `Name: Wert`:

```
X-Api-Key: geheim
User-Agent: PostmanRuntime/7.39.0
Accept:
```

Ein gleichnamiger Header ersetzt den Standard (unabhängig von der Schreibweise), ein **leerer
Wert entfernt** ihn. `Content-Length` und `Host` werden immer automatisch gesetzt.

Der Content-Type ist **in der Oberfläche unter „Erweiterte Einstellungen" änderbar** (z. B.
`text/plain` ohne charset, `application/xml`, `text/xml`, `application/octet-stream`) und wird
wie die übrigen Eingaben gespeichert. Der Vorgabewert lässt sich zusätzlich setzen über:

```bat
set SPAC_POST_CONTENT_TYPE=application/xml
start.bat
```

Das `charset` im Content-Type steuert dabei auch die **Byte-Kodierung des Bodys**:
`charset=iso-8859-1` (bzw. `windows-1252`) sendet Umlaute als Einzelbytes statt in UTF-8 –
relevant für Endpoints, die kein UTF-8 erwarten.

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
| `SPAC_POST_USER_AGENT` | `SPAC-PDF-Vergleichstool/1.0` | User-Agent des POST-Requests |
| `SPAC_POST_ACCEPT` | `*/*` | Accept-Header des POST-Requests |
| `SPAC_POST_TIMEOUT_MS` | `120000` | Zeitlimit für den Zielservice |
| `SPAC_MAX_UPLOAD` | `75mb` | maximale Größe von Upload/Antwort |
| `SPAC_LOG_FILE` | `logs/spac.log` | Pfad der Logdatei |
| `SPAC_LOG_BODY` | – | `1` protokolliert auch erfolgreiche Aufrufe mit vollem Body |
| `SPAC_LOG_MAX_BODY` | `100000` | maximale Zeichenzahl je Body im Log |

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
| FR3 Rohtext-Übertragung (Byte-Ebene, Header, charset) | `test/fr3-raw-body.test.js` |
| Protokollierung von Request-Body und Antwort im Fehlerfall | `test/logging.test.js` |
| Zusätzliche Header und cURL-Reproduktion | `test/extra-headers.test.js` |
| Aufzeichnung und Vergleich einer Fremd-Anfrage (Postman) | `test/capture-compare.test.js` |
| Abweichend kodierte Sonderzeichen | `test/sonderzeichen.test.js` |
| Symbolzeichen (Checkboxen) im Textvergleich | `test/symbolzeichen.test.js` |
| Nicht sichtbare Inhalte | `test/unsichtbare-inhalte.test.js` |
| Kopf-/Fußzeile ausschließen, Ziel-URL in den Einstellungen | `test/kopf-fusszeile.test.js` |
| Vertikalen Text (Rahmenvermerke) ausschließen | `test/vertikaler-text.test.js` |
| Lesereihenfolge unabhängig von der Zeichenreihenfolge | `test/lesereihenfolge.test.js` |
| Markdown-Vergleich (Textfassung, Zeilendiff, Reiter) | `test/markdown-compare.test.js` |
| Font- und Stilvergleich (Schrift, Größe, Schnitt, Farbe) | `test/style-compare.test.js` |
| FR4 PDF-Response anzeigen/speichern | `test/fr4-pdf-response.test.js` |
| FR5 seitenweiser Vergleich | `test/fr5-vergleich.test.js` |
| FR6 farbliche Hervorhebung (nur im generierten Dokument) | `test/fr6-hervorhebung.test.js` |
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

---

## Wenn der Zielendpoint den Request ablehnt

### Logdatei: `logs/spac.log`

**Bei jedem Fehler** wird der komplette Austausch in `logs/spac.log` (neben `start.bat`)
geschrieben und zusätzlich im Konsolenfenster ausgegeben: gesendete Header, der **vollständige
gesendete Body**, ein Hexdump der ersten Bytes sowie Status, Header und Body der Antwort des
Zielservice. Der Pfad zur Logdatei steht auch in der Fehlermeldung in der Oberfläche.

```
==============================================================================
[2026-07-28T12:40:53.634Z] FEHLER: POST http://server:8080/generate
Fehlercode: TARGET_STATUS
Meldung:    Der Zielservice hat mit HTTP 415 (Unsupported Media Type) geantwortet. …

--- GESENDETER REQUEST ---
POST http://server:8080/generate
Content-Type: text/plain; charset=utf-8
Content-Length: 86
Accept: application/pdf, */*

--- GESENDETER BODY (86 Bytes, Kodierung utf8) ---
C:\Vorlagen\rechnung.tpl

<rechnung nummer="4711">
  <betrag>100</betrag>
</rechnung>

--- BODY-ANFANG ALS HEX ---
0000  43 3a 5c 56 6f 72 6c 61 67 65 6e 5c 72 65 63 68  C:\Vorlagen\rech
0010  6e 75 6e 67 2e 74 70 6c 0a 0a 3c 72 65 63 68 6e  nung.tpl..<rechn

--- ANTWORT: HTTP 415 Unsupported Media Type ---
content-type: text/plain;charset=utf-8
content-length: 48

--- ANTWORT-BODY (48 Bytes) ---
Unsupported Media Type: erwartet application/xml
==============================================================================
```

Der Hexdump zeigt die tatsächlichen Bytes – daran lassen sich Kodierungsprobleme, ein
unerwartetes BOM oder falsche Zeilenenden zweifelsfrei erkennen.

**Auch erfolgreiche Aufrufe mitloggen** (mit vollem Body):

```bat
set SPAC_LOG_BODY=1
start.bat
```

Ohne diesen Schalter wird bei Erfolg nur eine Zeile geschrieben
(`POST … -> HTTP 200, 12345 Bytes PDF in 240 ms`).

### Den Unterschied automatisch finden lassen

Wenn derselbe Aufruf mit Postman funktioniert, hier aber nicht, findet die Anwendung den
Unterschied selbst. Unter **„Mit Postman (oder einem anderen Werkzeug) vergleichen"**:

1. Die dort angezeigte Adresse (`http://127.0.0.1:3000/api/capture`) in Postman **statt** der
   Ziel-URL eintragen und die funktionierende Anfrage einmal absenden. Die Anwendung zeichnet
   sie unverändert auf.
2. Zurück im Browser auf **Vergleichen** klicken.

Das Ergebnis benennt jeden Unterschied im Klartext, zum Beispiel:

```
• Der Header "X-Api-Key: geheim" fehlt in der Anwendung.
• Der Header "Content-Type" unterscheidet sich: Anwendung "text/plain; charset=utf-8",
  aufgezeichnet "text/plain".
• Die Zeilenenden unterscheiden sich: Anwendung LF, aufgezeichnet CRLF.
• Erste Abweichung im Body an Byte 24.
    Anwendung     …rechnung.tpl\n\n<rechnung…   0a 0a 3c
    Aufgezeichnet …rechnung.tpl\r\n\r\n<rechnung…  0d 0a 0d 0a 3c
```

Dazu eine Gegenüberstellung aller Header und der Bodys auf Byte-Ebene. Die Schaltfläche
**„Abweichende Header übernehmen"** trägt die fehlenden Header und ggf. den Content-Type
direkt in die Einstellungen ein. Es wird dabei nichts an den Zielservice gesendet.

### Zeilenenden (häufigste Ursache)

Die Anwendung normalisiert den Body standardmäßig auf **LF**. Postman sendet unter Windows in
der Regel **CRLF** – reagiert der Endpoint darauf empfindlich, funktioniert derselbe Text in
Postman und hier nicht. Unter „Erweiterte Einstellungen" lässt sich das umstellen:

| Einstellung | Wirkung |
| --- | --- |
| `LF (\n)` | Standard, alles wird auf `\n` vereinheitlicht |
| `CRLF (\r\n)` | durchgängig Windows-Zeilenenden, auch zwischen Vorlagepfad und Leerzeile |
| `Unverändert aus der XML-Datei` | die Zeilenenden der Datei bleiben, wie sie sind |

### Aufruf 1:1 nachstellen (Vergleich mit Postman & Co.)

Log und Diagnose enthalten einen **cURL-Befehl, der den Aufruf exakt reproduziert**, sowie den
gesendeten Body als Datei (`logs/last-request-body.txt`):

```
curl -X POST "http://server:8080/generate" -H "Content-Type: text/plain" -H "Accept: */*" \
  -H "User-Agent: SPAC-PDF-Vergleichstool/1.0" --data-binary "@…\logs\last-request-body.txt" \
  --output antwort.pdf
```

Der Befehl ist einzeilig, damit er in `cmd`, PowerShell und Bash gleichermaßen funktioniert.
Läuft der Aufruf mit einem anderen Werkzeug (z. B. Postman) durch, hier aber nicht, liegt der
Unterschied in den Headern: Header in Postman anzeigen lassen, mit der obigen Liste vergleichen
und die fehlenden unter „Zusätzliche Header" ergänzen.

### Diagnose in der Oberfläche

Dieselben Angaben stehen im aufklappbaren Bereich **„Gesendeter Request (Diagnose)"** unter
dem Ergebnis – im Fehlerfall öffnet er sich automatisch und enthält zusätzlich die
vollständige Antwort des Zielservice.

Typische Stellschrauben:

| Symptom | Ansatzpunkt |
| --- | --- |
| HTTP 415 / „Unsupported Media Type" | Content-Type unter „Erweiterte Einstellungen" ändern, z. B. auf `text/plain` (ohne charset), `application/xml` oder `text/xml` |
| HTTP 401/403, obwohl Postman funktioniert | Fehlender Header. Postman sendet u. a. `User-Agent` und ggf. Schlüssel/Token – unter „Zusätzliche Header" ergänzen |
| HTTP 406 | `Accept:` (leerer Wert) setzen, um den Header ganz wegzulassen |
| Umlaute kommen falsch an | `charset=iso-8859-1` im Content-Type setzen |
| Funktioniert in Postman, hier nicht | Zeilenenden auf CRLF stellen und/oder „Mit Postman vergleichen" nutzen |
| HTTP 400 mit Verweis auf die XML-Struktur | Body in der Diagnose prüfen: Zeile 1 = Vorlagepfad, Zeile 2 leer, ab Zeile 3 die XML ohne Deklaration |
| Antwort ist HTML statt PDF | Die Fehlermeldung zeigt den Anfang der Antwort – meist eine Fehlerseite des Zielservice |
