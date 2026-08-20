/**
 * Auswahl der Vorlagepfade.
 *
 * Zur Auswahl stehende Vorlagepfade werden aus einer einfachen Konfigurationsdatei im
 * Wurzelverzeichnis gelesen (`vorlagepfade.txt`): ein Pfad je Zeile. Leerzeilen und mit `#`
 * beginnende Zeilen werden übersprungen, sodass sich die Liste kommentieren lässt. So kann die
 * Liste ohne Eingriff in den Code angepasst werden. Fehlt die Datei oder ist sie leer, gelten
 * die eingebauten Vorgaben.
 *
 * Der erste Eintrag ist die Voreinstellung beim Start.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Name der Konfigurationsdatei im Wurzelverzeichnis. */
export const CONFIG_FILE = 'vorlagepfade.txt';

/** Eingebaute Vorgaben, falls keine Konfigurationsdatei vorhanden ist. */
export const DEFAULT_TEMPLATE_PATHS = [
  'icm://Interactive/VHV/Templates/KFZ',
  'icm://Interactive/VHV/Templates/KFZ/Hell',
  'icm://Interactive/VHV/Templates/Schaden KFZ',
  'icm://Interactive/VHV/Templates/Schaden KFZ/Hell',
  'icm://Interactive/VHV/Templates/Leben',
];

/** Zerlegt den Dateiinhalt in eine Liste von Pfaden. */
export function parseTemplatePaths(text) {
  return String(text)
    .split(/\r?\n/)
    .map((zeile) => zeile.trim())
    .filter((zeile) => zeile !== '' && !zeile.startsWith('#'));
}

/**
 * Liest die Vorlagepfade aus der Konfigurationsdatei im angegebenen Wurzelverzeichnis.
 * Fehlt die Datei oder enthält sie keinen einzigen Pfad, werden die Vorgaben zurückgegeben.
 * @returns {string[]}
 */
export function readTemplatePaths(rootDir) {
  try {
    const inhalt = fs.readFileSync(path.join(rootDir, CONFIG_FILE), 'utf8');
    const pfade = parseTemplatePaths(inhalt);
    if (pfade.length > 0) return pfade;
  } catch {
    /* Datei fehlt oder ist nicht lesbar – Vorgaben verwenden. */
  }
  return [...DEFAULT_TEMPLATE_PATHS];
}
