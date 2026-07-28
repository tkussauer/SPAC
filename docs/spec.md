# Web-Anwendung: PDF-Vergleichstool

## Funktionale Anforderungen

**FR1 – Eingabemaske mit vier Feldern:**
- Test-XML-Datei (lokale Dateiauswahl, .xml)
- Referenz-PDF-Datei (lokale Dateiauswahl, .pdf)
- Ziel-URL für den POST-Aufruf (Texteingabe)
- Vorlagepfad (Texteingabe, freier String)

**FR2 –** Button "Vergleich generieren" löst einen POST-Request an die eingegebene URL aus.

**FR3 – Aufbau des POST-Body** (reiner Text, siehe Klärungspunkt zum Content-Type):
```
Zeile 1: Vorlagepfad
Zeile 2: leer
Danach: Inhalt der Test-XML-Datei, aber OHNE die erste Zeile
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
```

**FR4 –** Die Response des POST-Aufrufs ist das generierte PDF (Vergleichsdokument) und wird in der Anwendung angezeigt/gespeichert.

**FR5 –** Das generierte PDF wird automatisch mit der hochgeladenen Referenz-PDF verglichen (Seite für Seite).

**FR6 –** Abweichungen zwischen den beiden PDFs werden farblich hervorgehoben (z. B. rot markierte Bereiche) in der UI dargestellt.

**FR7 –** Ein "Refresh"-Button wiederholt den POST-Aufruf mit denselben aktuell eingegebenen Werten (URL, Vorlagepfad, Test-XML) und aktualisiert Vergleichsergebnis und Hervorhebung.

**FR8 –** Die Anwendung muss von einem Windows-Desktop aus startbar sein (z. B. per Verknüpfung/Batch-Datei, die den lokalen Server startet und den Browser öffnet).

## Nicht-funktionale Anforderungen

**NFR1 –** Läuft lokal unter Windows, keine Internetverbindung nötig außer zum konfigurierten POST-Endpoint.

**NFR2 –** Fehlerbehandlung: ungültige Datei, nicht erreichbare URL, fehlerhafte PDF-Response werden dem Nutzer verständlich angezeigt.

**NFR3 –** Eingegebene URL und Vorlagepfad bleiben zwischen Generieren/Refresh erhalten (kein erneutes Eintippen nötig).

**NFR4 –** Start-/Setup-Aufwand für den Nutzer minimal (Doppelklick genügt).

## Offene Klärungspunkte

Bitte vor Umsetzung entscheiden (oder vom Umsetzungstool sinnvoll wählen und dokumentieren lassen):

- **Tech-Stack:** Vorschlag: Node.js/Express Backend + einfaches HTML/JS Frontend, oder .NET, falls das Zielsystem das bevorzugt.
- **Content-Type des POST-Requests:** text/plain, application/xml, multipart/form-data? Falls der Zielendpoint das vorgibt, hier eintragen.
- **PDF-Diff-Methode:** Pixel-Vergleich pro Seite vs. Text-Extraktion-Diff.
- **Validierung "Vorlagepfad":** nur String oder tatsächlicher Dateisystempfad, der geprüft wird?
