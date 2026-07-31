# Installationsanleitung – PDF-Vergleichstool (Windows)

Diese Anleitung führt Schritt für Schritt durch Installation und Start unter Windows 10/11.
Für den normalen Betrieb genügt am Ende ein **Doppelklick auf `start.bat`**.

---

## 1. Überblick – was wird benötigt?

| | |
| --- | --- |
| **Betriebssystem** | Windows 10 oder 11 (64-Bit) |
| **Voraussetzung** | Node.js 20 oder neuer (einmalig zu installieren) |
| **Rechte** | Für Node.js empfohlen: Administrator. Die Anwendung selbst läuft ohne Adminrechte. |
| **Internet** | Nur beim **ersten** Start (lädt die Programmbausteine). Danach genügt eine Verbindung zum PDF-Endpoint. |
| **Speicherplatz** | ca. 250 MB (überwiegend `node_modules`) |

> Es müssen keine weiteren Programme installiert werden – kein ImageMagick, kein Ghostscript,
> keine Datenbank. Die Anwendung läuft vollständig lokal auf dem eigenen Rechner.

---

## 2. Node.js installieren (einmalig)

1. [https://nodejs.org/](https://nodejs.org/) öffnen.
2. Die Schaltfläche **„LTS"** anklicken (empfohlene, stabile Version – 20 oder neuer).
   Es lädt eine Datei wie `node-v20.x.x-x64.msi` herunter.
3. Die heruntergeladene `.msi`-Datei doppelklicken und den Installationsassistenten
   durchklicken. **Alle Vorgaben können übernommen werden** – insbesondere die Option
   *„Add to PATH"* muss aktiviert bleiben (Standard).
4. Installation abschließen und den Rechner **einmal neu anmelden** oder neu starten, damit
   der Suchpfad (`PATH`) aktualisiert wird.

**Prüfen, ob es geklappt hat:** Eingabeaufforderung öffnen (Windows-Taste → `cmd` eintippen →
Enter) und eingeben:

```bat
node -v
```

Es sollte eine Versionsnummer wie `v20.11.1` erscheinen. Wird stattdessen
*„'node' ist nicht als interner oder externer Befehl … erkannt"* angezeigt, ist Node.js nicht
korrekt im PATH – siehe [Abschnitt 9](#9-problembehebung).

---

## 3. Das Programm auf den Rechner bringen

Es gibt zwei Wege – einer genügt.

### Weg A: Als ZIP herunterladen (ohne Git)

1. Die Projektseite im Browser öffnen.
2. **Code ▾ → Download ZIP** wählen.
3. Die ZIP-Datei an einen Ort **entpacken**, an dem Schreibrechte bestehen, z. B.
   `C:\Tools\PDF-Vergleichstool` oder `Dokumente`.
   *Nicht* nach `C:\Programme` entpacken (dort fehlen i. d. R. Schreibrechte).

### Weg B: Mit Git klonen (für Updates komfortabler)

Falls [Git für Windows](https://git-scm.com/download/win) installiert ist, in der
Eingabeaufforderung:

```bat
cd C:\Tools
git clone <REPOSITORY-URL> PDF-Vergleichstool
```

> Nach dem Entpacken/Klonen muss im Ordner die Datei **`start.bat`** liegen. Ist das der Fall,
> ist alles am richtigen Platz.

---

## 4. Erster Start

1. In den entpackten Ordner wechseln (dort, wo `start.bat` liegt).
2. **Doppelklick auf `start.bat`.**

Beim ersten Start erscheint ein schwarzes Konsolenfenster. `start.bat` erledigt automatisch:

- Prüfung, ob Node.js vorhanden ist,
- **`npm install`** – lädt die Programmbausteine (nur beim ersten Mal, dauert 1–3 Minuten und
  braucht Internet),
- **Aufbau der Oberfläche**,
- **Start des lokalen Servers** unter `http://127.0.0.1:3000`,
- **Öffnen der Anwendung** im Standardbrowser.

Der Browser öffnet sich nach wenigen Sekunden von selbst. Erscheint er nicht, im Browser
manuell **`http://127.0.0.1:3000`** aufrufen.

> **Windows-SmartScreen-Hinweis:** Beim ersten Doppelklick kann *„Der Computer wurde durch
> Windows geschützt"* erscheinen. Auf **„Weitere Informationen" → „Trotzdem ausführen"**
> klicken. Das ist normal für Skript-Dateien aus dem Internet.

Das Konsolenfenster muss **geöffnet bleiben**, solange die Anwendung genutzt wird – es ist der
laufende Server. Zum Beenden das Fenster schließen oder `Strg + C` drücken.

---

## 5. Tägliche Nutzung

- **Starten:** Doppelklick auf `start.bat` (ab dem zweiten Mal ohne Internet und ohne die
  Installationsschritte – es geht in wenigen Sekunden).
- **Beenden:** Konsolenfenster schließen.

### Verknüpfung auf dem Desktop anlegen

Damit die Anwendung bequem per Desktop-Symbol startet:

1. Rechtsklick auf `start.bat`.
2. **Senden an → Desktop (Verknüpfung erstellen)**.
3. Optional: Verknüpfung umbenennen (z. B. „PDF-Vergleichstool") und über
   *Rechtsklick → Eigenschaften → Anderes Symbol* ein Icon vergeben.

---

## 6. Bedienung in Kürze

1. **Test-XML-Datei** auswählen.
2. **Referenz-PDF-Datei** auswählen.
3. **Vorlagepfad** eintragen.
4. **Vergleich generieren** klicken.

Die **Ziel-URL** ist bereits vorbelegt
(`https://inspire-scaler.ccm.dev.babiel.com/rest/api/submit-job/CreateTestDocumentDl`) und
steht unter **„Erweiterte Einstellungen"** – nur bei einem anderen Ziel anpassen. Alle Eingaben
bleiben bis zum nächsten Start gespeichert.

Ausführliche Erklärungen zu den Vergleichsansichten und Filtern stehen in der
[README](../README.md).

---

## 7. Netzwerk und Datenschutz

- Die Anwendung lauscht nur lokal auf `127.0.0.1` und ist **nicht aus dem Netz erreichbar**.
- Nach außen geht **ausschließlich** der POST-Aufruf an die eingetragene Ziel-URL. Kann der
  Rechner diese URL erreichen (ggf. VPN/Firmennetz nötig), funktioniert der Vergleich.
- Ausgewählte Dateien werden **nicht** dauerhaft gespeichert; sie liegen nur im Arbeitsspeicher
  des laufenden Servers und sind nach dem Beenden weg.
- Bei Fehlern wird ein Protokoll unter `logs\spac.log` im Programmordner abgelegt (enthält den
  gesendeten Request-Body – bei sensiblen Daten entsprechend behandeln).

---

## 8. Aktualisieren

- **Bei ZIP-Installation:** neue ZIP herunterladen, entpacken und den alten Ordner ersetzen.
  Den Unterordner `node_modules` kann man mitkopieren; andernfalls installiert der nächste
  `start.bat`-Aufruf ihn neu.
- **Bei Git-Installation:** im Ordner `git pull` ausführen. Der nächste `start.bat`-Start
  übernimmt geänderte Bausteine automatisch.

---

## 9. Problembehebung

| Symptom | Ursache & Lösung |
| --- | --- |
| **„Node.js wurde nicht gefunden"** | Node.js ist nicht (korrekt) installiert. [Abschnitt 2](#2-nodejs-installieren-einmalig) wiederholen und danach neu anmelden. `node -v` in der Eingabeaufforderung muss eine Version zeigen. |
| **`npm install` schlägt fehl** | Meist fehlendes Internet oder ein Firmen-Proxy. Im Firmennetz den Proxy setzen: `npm config set proxy http://PROXY:PORT` und `npm config set https-proxy http://PROXY:PORT`, dann `start.bat` erneut. |
| **Konsole schließt sofort / zeigt kurz einen Fehler** | `start.bat` per Rechtsklick → *Bearbeiten* ansehen ist nicht nötig; stattdessen: Eingabeaufforderung im Ordner öffnen (in der Adressleiste des Explorers `cmd` eintippen) und `start.bat` dort eingeben – dann bleibt die Fehlermeldung sichtbar. |
| **„Der Computer wurde durch Windows geschützt" (SmartScreen)** | Normal bei Skripten. **„Weitere Informationen" → „Trotzdem ausführen"**. |
| **Port 3000 ist belegt** | Anderen Port verwenden: Eingabeaufforderung im Ordner öffnen und `set SPAC_PORT=8080` , danach `start.bat`. Die Anwendung läuft dann unter `http://127.0.0.1:8080`. |
| **Browser öffnet nicht automatisch** | Im Browser `http://127.0.0.1:3000` manuell eingeben. |
| **Vergleich meldet „URL nicht erreichbar"** | Der Rechner erreicht die Ziel-URL nicht (VPN/Firewall). Netzwerkzugang prüfen; die Fehlermeldung in der Oberfläche nennt Details, das Protokoll steht in `logs\spac.log`. |
| **„Kein Speicherplatz" / sehr langsam** | Der Ordner sollte auf einer lokalen Festplatte mit etwas freiem Platz liegen, nicht auf einem vollen oder Netzlaufwerk. |

---

## 10. Deinstallation

Es werden keine Einträge in Windows oder Registry angelegt. Zum vollständigen Entfernen genügt
es, den **Programmordner zu löschen**. Node.js kann – falls nicht anderweitig benötigt – über
*Einstellungen → Apps* deinstalliert werden.

---

## 11. Für Fachkundige: manueller Start

Ohne `start.bat` (identisches Ergebnis) in der Eingabeaufforderung im Programmordner:

```bat
npm install       :: nur beim ersten Mal
npm start         :: baut die Oberfläche und startet den Server
```

Umgebungsvariablen (optional, jeweils vor `start.bat` bzw. `npm start` setzen):

| Variable | Vorgabe | Bedeutung |
| --- | --- | --- |
| `SPAC_PORT` | `3000` | Port des lokalen Servers |
| `SPAC_HOST` | `127.0.0.1` | Netzwerkadresse |
| `SPAC_POST_CONTENT_TYPE` | `text/plain; charset=utf-8` | Content-Type des POST-Requests |
| `SPAC_LOG_BODY` | – | `1` protokolliert auch erfolgreiche Aufrufe mit vollem Body |

Eine vollständige Liste der Variablen steht in der [README](../README.md).
