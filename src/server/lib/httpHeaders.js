import { AppError } from './errors.js';

/** Header, die aus dem Body abgeleitet werden und nicht überschrieben werden dürfen. */
const GESCHUETZT = new Set(['content-length', 'host']);

/**
 * Liest zusätzliche Header aus einer Texteingabe (eine Zeile je Header, "Name: Wert").
 * Leerzeilen und mit # beginnende Zeilen werden übersprungen.
 */
export function parseHeaderLines(text) {
  if (typeof text !== 'string' || text.trim() === '') return {};

  const headers = {};
  const zeilen = text.replace(/\r\n?/g, '\n').split('\n');

  zeilen.forEach((zeile, index) => {
    const inhalt = zeile.trim();
    if (inhalt === '' || inhalt.startsWith('#')) return;

    const trenner = inhalt.indexOf(':');
    if (trenner <= 0) {
      throw new AppError(
        'HEADER_INVALID',
        `Zeile ${index + 1} der zusätzlichen Header ist ungültig: "${inhalt}". Erwartet wird "Name: Wert".`
      );
    }

    const name = inhalt.slice(0, trenner).trim();
    const wert = inhalt.slice(trenner + 1).trim();

    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new AppError('HEADER_INVALID', `"${name}" ist kein gültiger Header-Name.`);
    }
    if (GESCHUETZT.has(name.toLowerCase())) {
      throw new AppError(
        'HEADER_PROTECTED',
        `Der Header "${name}" wird automatisch gesetzt und kann nicht überschrieben werden.`
      );
    }

    headers[name] = wert;
  });

  return headers;
}

/**
 * Führt Standard- und Zusatzheader zusammen. Ein Zusatzheader ersetzt einen
 * gleichnamigen Standardheader (unabhängig von Groß-/Kleinschreibung); ein leerer
 * Wert entfernt ihn – so lässt sich z. B. das Accept des Standards abschalten.
 */
export function mergeHeaders(defaults, extra) {
  const ergebnis = { ...defaults };

  for (const [name, wert] of Object.entries(extra ?? {})) {
    for (const vorhanden of Object.keys(ergebnis)) {
      if (vorhanden.toLowerCase() === name.toLowerCase()) delete ergebnis[vorhanden];
    }
    if (wert !== '') ergebnis[name] = wert;
  }

  return ergebnis;
}

/** Maskiert einen Wert für doppelte Anführungszeichen (cmd, PowerShell und Shell tauglich). */
function quote(value) {
  return String(value).replace(/"/g, '\\"');
}

/**
 * Baut einen cURL-Befehl, der den Aufruf exakt reproduziert.
 * Der Body wird aus einer Datei gelesen, damit Zeilenumbrüche und Kodierung
 * unverändert bleiben – so lässt sich der Aufruf 1:1 mit Postman vergleichen.
 */
export function buildCurlCommand({ targetUrl, headers, bodyFile }) {
  const teile = [`curl -X POST "${quote(targetUrl)}"`];
  for (const [name, wert] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === 'content-length') continue; // setzt cURL selbst
    teile.push(`-H "${quote(name)}: ${quote(wert)}"`);
  }
  teile.push(`--data-binary "@${quote(bodyFile ?? 'body.txt')}"`);
  teile.push('--output antwort.pdf');
  // Bewusst einzeilig: Zeilenfortsetzungen unterscheiden sich zwischen
  // cmd (^), PowerShell (`) und Bash (\) – so ist der Befehl überall kopierbar.
  return teile.join(' ');
}
