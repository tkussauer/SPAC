# Installation unter Windows

In drei Schritten:

## 1. Entzippen

Die ZIP-Datei in einen Ordner mit Schreibrechten entpacken, z. B.
`C:\Tools\PDF-Vergleichstool` (nicht nach `C:\Programme`). Im Ordner muss `start.bat` liegen.

## 2. Node.js/npm installieren (einmalig)

[nodejs.org](https://nodejs.org/) öffnen, **LTS** herunterladen, die `.msi` mit den Vorgaben
installieren. (npm ist dabei enthalten.)

> **Keine Installationsrechte?** Siehe unten – Node.js gibt es auch als ZIP zum Entpacken.

## 3. `start.bat` aufrufen

Doppelklick auf **`start.bat`**. Der erste Start lädt einmalig die Bausteine (braucht Internet),
danach öffnet sich die Anwendung automatisch im Browser unter `http://127.0.0.1:3000`.

Ab dem zweiten Mal: einfach wieder `start.bat` – in Sekunden, ohne Internet.

---

**Kurz-Tipps:** Bei der SmartScreen-Meldung „Weitere Informationen → Trotzdem ausführen". Das
Konsolenfenster offen lassen (= laufender Server); zum Beenden schließen. Öffnet der Browser
nicht, `http://127.0.0.1:3000` manuell aufrufen.

---

# Ohne Installationsrechte

Node.js **muss nicht installiert werden**. Es gibt drei Wege – je nachdem, was gesperrt ist.

## A. Node.js als ZIP entpacken (empfohlen)

Node.js wird auch als einfaches ZIP angeboten. Entpacken genügt, es wird nichts in die
Registry geschrieben und nichts unter `C:\Programme` abgelegt – also keine Administratorrechte.

1. Auf [nodejs.org/en/download](https://nodejs.org/en/download) bei **LTS** als Paketformat
   **Windows Binary (.zip)**, Architektur **x64** wählen und herunterladen.
2. Das ZIP entpacken. Darin liegt ein Ordner `node-v22.x.x-win-x64` mit `node.exe`.
3. Den **Inhalt** dieses Ordners in den Unterordner `node\` des Tools verschieben, sodass es
   genau so aussieht:

   ```
   PDF-Vergleichstool\
     start.bat
     node\
       node.exe
       npm.cmd
       node_modules\
     src\
     ...
   ```

4. `start.bat` starten. Es meldet „Mitgeliefertes Node.js wird verwendet" und nutzt diese
   Kopie – ganz gleich, ob auf dem Rechner Node.js installiert ist oder nicht.

Das funktioniert auch von einem USB-Stick oder einem Netzlaufwerk.

## B. Komplettpaket ohne jeden Download

Ist zusätzlich der Zugang zur npm-Registry gesperrt (der erste Start bricht dann bei
`npm install` ab), hilft ein Paket, in dem `node\` und `node_modules\` bereits enthalten sind.
Dort ist auch das Frontend schon gebaut. Ablauf für die Anwender:

1. ZIP entpacken.
2. `start.bat` doppelklicken.

Mehr nicht – kein Download, kein Internet, keine Rechte.

## C. Nur ein Rechner betreibt das Tool

Es ist eine Web-Anwendung: Auf **einem** Rechner (oder einem kleinen Server) läuft sie, alle
anderen benutzen sie im Browser. Dazu vor dem Start die Bindeadresse öffnen:

```bat
set SPAC_HOST=0.0.0.0
start.bat
```

Danach erreichen Kolleginnen und Kollegen das Tool unter `http://<Rechnername>:3000/` – ohne
irgendetwas zu installieren.

> Zu beachten: Das Tool hat bewusst **keine Anmeldung** und ist als lokales Werkzeug gedacht.
> Diese Variante nur im vertrauenswürdigen internen Netz verwenden, und in der Windows-Firewall
> muss Port 3000 freigegeben sein (dafür braucht es meist doch Adminrechte – oft ist es
> einfacher, das Tool auf einer bestehenden Test-VM zu betreiben).


---

# Wenn ein Inhalt im Vergleich fehlt

Manche Inhalte stehen nicht dort, wo eine Textextraktion sie erwartet – etwa Werte in
Formularfeldern. Was die Anwendung in einem PDF tatsächlich sieht, zeigt die Diagnose:

1. Das betroffene PDF im Tool über **„PDF herunterladen"** speichern (oder die Referenzdatei
   nehmen).
2. Diese Datei mit der Maus auf **`diagnose.bat`** ziehen und loslassen.
3. Es öffnet sich ein Fenster mit dem Ergebnis. Dasselbe steht in **`diagnose-ausgabe.txt`**
   im Tool-Ordner – diese Datei lässt sich verschicken.

Ohne Drag & Drop geht es auch per Doppelklick auf `diagnose.bat`; dann wird nach dem Pfad
gefragt.

Die Ausgabe nennt je Seite alle Formularfelder mit **Feldwert** und **gezeichnetem Wert**,
die Zahl der Textelemente und ob es sich um ein dynamisches **XFA**-Formular handelt. Ein
solches Formular baut erst der Acrobat Reader aus XML-Daten auf; sein Inhalt steht gar nicht
als PDF im Dokument und ist für jeden anderen Betrachter unsichtbar.
