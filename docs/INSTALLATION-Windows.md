# Installation unter Windows

In drei Schritten:

## 1. Entzippen

Die ZIP-Datei in einen Ordner mit Schreibrechten entpacken, z. B.
`C:\Tools\PDF-Vergleichstool` (nicht nach `C:\Programme`). Im Ordner muss `start.bat` liegen.

## 2. Node.js/npm installieren (einmalig)

[nodejs.org](https://nodejs.org/) öffnen, **LTS** herunterladen, die `.msi` mit den Vorgaben
installieren. (npm ist dabei enthalten.)

## 3. `start.bat` aufrufen

Doppelklick auf **`start.bat`**. Der erste Start lädt einmalig die Bausteine (braucht Internet),
danach öffnet sich die Anwendung automatisch im Browser unter `http://127.0.0.1:3000`.

Ab dem zweiten Mal: einfach wieder `start.bat` – in Sekunden, ohne Internet.

---

**Kurz-Tipps:** Bei der SmartScreen-Meldung „Weitere Informationen → Trotzdem ausführen". Das
Konsolenfenster offen lassen (= laufender Server); zum Beenden schließen. Öffnet der Browser
nicht, `http://127.0.0.1:3000` manuell aufrufen.
