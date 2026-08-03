#!/usr/bin/env node
/**
 * Zeigt, was die Anwendung in einem PDF sieht.
 *
 * Gedacht für den Fall, dass ein Inhalt im Vergleich fehlt, obwohl er im Acrobat Reader zu
 * sehen ist. Ausgegeben werden Seiteninhalt, Formularfelder und Annotationen – also genau die
 * Quellen, aus denen der Vergleich seinen Text bezieht.
 *
 *   node scripts/pdf-diagnose.mjs pfad\zum\dokument.pdf
 *   node scripts/pdf-diagnose.mjs dokument.pdf --text     (zusätzlich der ganze Text)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { extractPages } from '../src/server/lib/pdfText.js';
import { collectAnnotationTexts } from '../src/server/lib/pdfStyle.js';
import { xfaFieldValues, xfaLookupName } from '../src/server/lib/xfa.js';

const require = createRequire(import.meta.url);

const [, , datei, ...rest] = process.argv;
if (!datei) {
  console.error('\n  Aufruf: node scripts/pdf-diagnose.mjs <datei.pdf> [--text]\n');
  process.exit(1);
}
const mitText = rest.includes('--text');

const buffer = await readFile(datei);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const standardFontDataUrl = pathToFileURL(
  path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep
).href;

const doc = await pdfjs.getDocument({
  data: new Uint8Array(buffer),
  standardFontDataUrl,
  useSystemFonts: false,
  isEvalSupported: false,
  verbosity: 0,
}).promise;

const zeile = (text = '') => console.log(text);
const kuerzen = (wert, laenge = 60) => {
  const text = Array.isArray(wert) ? wert.join(' | ') : String(wert ?? '');
  return text.length > laenge ? `${text.slice(0, laenge)}…` : text;
};

zeile();
zeile(`Datei            : ${path.resolve(datei)}`);
zeile(`Groesse          : ${buffer.length} Bytes`);
zeile(`Seiten           : ${doc.numPages}`);
zeile(`pdf.js           : ${pdfjs.version}`);

// --------------------------------------------------------------- Formular-Art
const { info } = await doc.getMetadata().catch(() => ({ info: {} }));
zeile(`Erzeugt von      : ${info?.Producer || 'unbekannt'} / ${info?.Creator || 'unbekannt'}`);
zeile(`Reines XFA       : ${doc.isPureXfa ? 'JA – dynamisches Formular, nur Acrobat stellt es dar' : 'nein'}`);

// Rohsuche in den Bytes: erfasst auch hybride Formulare, bei denen pdf.js kein reines XFA
// meldet, die Daten aber trotzdem im XFA-Teil stehen. Bei komprimierten Objektstroemen kann
// die Suche fehlgehen – deshalb nur als Hinweis.
const roh = buffer.toString('latin1');
const hatXfa = roh.includes('/XFA');
const hatNeedAppearances = /\/NeedAppearances\s+true/.test(roh);
const xfaWerte = xfaFieldValues(buffer);
zeile(
  `XFA-Daten        : ${hatXfa ? 'ja' : 'nicht gefunden'}` +
    `${xfaWerte.size > 0 ? ` – ${xfaWerte.size} Feldwerte darin` : ''}`
);
zeile(`NeedAppearances  : ${hatNeedAppearances ? 'ja – Erscheinungsstroeme erzeugt erst der Betrachter' : 'nein'}`);

let fieldObjects = null;
try {
  fieldObjects = await doc.getFieldObjects();
} catch {
  fieldObjects = null;
}
const felder = fieldObjects ? Object.entries(fieldObjects) : [];
zeile(`AcroForm-Felder  : ${felder.length === 0 ? 'keine gefunden' : `${felder.length} Feldnamen`}`);

if (felder.length > 0) {
  zeile();
  zeile('Formularfelder (Name -> Typ, Wert)');
  zeile('-'.repeat(78));
  for (const [name, eintraege] of felder) {
    for (const eintrag of eintraege) {
      const wert = eintrag.value;
      const leer = wert === null || wert === undefined || String(wert).trim() === '';
      zeile(
        `  ${name.padEnd(28).slice(0, 28)} ${String(eintrag.type ?? '?').padEnd(10)} ` +
          `${leer ? '(leer)' : kuerzen(wert)}${eintrag.hidden ? '   [ausgeblendet]' : ''}`
      );
    }
  }
}

// ------------------------------------------------------------------- Je Seite
for (let nummer = 1; nummer <= doc.numPages; nummer += 1) {
  const page = await doc.getPage(nummer);
  const content = await page.getTextContent();
  const annotations = await page.getAnnotations({ intent: 'display' }).catch(() => []);
  const widgets = annotations.filter((a) => a.subtype === 'Widget');
  // Was die Annotationen tatsächlich zeichnen (Erscheinungsströme).
  let gezeichnet = new Map();
  try {
    gezeichnet = collectAnnotationTexts(await page.getOperatorList(), pdfjs.OPS);
  } catch {
    gezeichnet = new Map();
  }

  zeile();
  zeile(`Seite ${nummer}`);
  zeile('-'.repeat(78));
  zeile(`  Textelemente im Seiteninhalt : ${content.items.length}`);
  zeile(`  Annotationen                 : ${annotations.length} (davon Formularfelder: ${widgets.length})`);

  const andere = annotations.filter((a) => a.subtype !== 'Widget');
  if (andere.length > 0) {
    const arten = [...new Set(andere.map((a) => a.subtype))].join(', ');
    zeile(`  Andere Annotationsarten      : ${arten}`);
  }

  for (const widget of widgets) {
    const wert = Array.isArray(widget.fieldValue) ? widget.fieldValue.join(' | ') : widget.fieldValue;
    const leer = wert === null || wert === undefined || String(wert).trim() === '';
    const merkmale = [
      widget.hidden ? 'ausgeblendet' : null,
      widget.readOnly ? 'schreibgeschuetzt' : null,
      widget.multiLine ? 'mehrzeilig' : null,
      widget.hasAppearance === false ? 'ohne Erscheinungsstrom' : null,
    ].filter(Boolean);
    const gezeichneterWert = gezeichnet.get(widget.id);
    zeile(
      `    - ${String(widget.fieldName ?? '?').padEnd(24).slice(0, 24)} ` +
        `${String(widget.fieldType ?? '?').padEnd(4)} ` +
        `Feldwert: ${leer ? '(leer)' : kuerzen(wert, 30)}` +
        `${merkmale.length > 0 ? `   [${merkmale.join(', ')}]` : ''}`
    );
    const ausXfa = xfaWerte.get(xfaLookupName(widget.fieldName));
    zeile(
      `      ${' '.repeat(24)}      gezeichnet: ` +
        `${gezeichneterWert ? kuerzen(gezeichneterWert, 30) : '(nichts)'}` +
        `${ausXfa ? `   XFA: ${kuerzen(ausXfa, 30)}` : ''}`
    );
  }
}

// ------------------------------------------------- Was der Vergleich daraus macht
const { pages } = await extractPages(buffer, { label: 'Das PDF' });
const alle = pages.flatMap((p) => p.words);
const ausFeldern = alle.filter((w) => w.formField);
const unsichtbar = alle.filter((w) => w.invisible);
const symbole = alle.filter((w) => w.symbol);

zeile();
zeile('Ergebnis der Textextraktion (das, womit verglichen wird)');
zeile('-'.repeat(78));
zeile(`  Woerter gesamt               : ${alle.length}`);
zeile(`  davon aus Formularfeldern    : ${ausFeldern.length}`);
zeile(`  davon als unsichtbar erkannt : ${unsichtbar.length}  (werden standardmaessig ignoriert)`);
zeile(`  davon als Symbol erkannt     : ${symbole.length}  (werden standardmaessig ignoriert)`);

if (ausFeldern.length > 0) {
  zeile();
  zeile(`  Aus Formularfeldern uebernommen: ${kuerzen(ausFeldern.map((w) => w.text).join(' '), 300)}`);
}

if (mitText) {
  for (const page of pages) {
    zeile();
    zeile(`Text der Seite ${page.pageNumber}`);
    zeile('-'.repeat(78));
    zeile(page.words.map((w) => w.text).join(' '));
  }
}

zeile();
zeile('Einschaetzung');
zeile('-'.repeat(78));
if (doc.isPureXfa) {
  zeile('  Das ist ein dynamisches XFA-Formular. Der sichtbare Inhalt wird erst vom Acrobat');
  zeile('  Reader aus den XFA-Daten aufgebaut und steht so nicht im PDF. Kein Betrachter');
  zeile('  ausser Acrobat zeigt ihn an - ein Vergleich ist erst moeglich, wenn der');
  zeile('  Zielservice ein normales PDF ausliefert.');
} else if (felder.length === 0) {
  zeile('  Es gibt keine Formularfelder. Fehlender Text hat dann eine andere Ursache -');
  zeile('  bitte die Zeile "Textelemente im Seiteninhalt" je Seite ansehen.');
} else if (ausFeldern.length === 0) {
  zeile('  Es gibt Formularfelder, aber keines liefert Text: weder ein Feldwert noch ein');
  zeile('  gezeichneter Wert. Wenn die Werte auch in einem normalen Betrachter (nicht');
  zeile('  Acrobat) fehlen, stehen sie schlicht nicht im Dokument - dann liegt es am');
  zeile('  erzeugenden Dienst und nicht an der Anwendung.');
  if (hatXfa) {
    zeile('  Achtung: Das Dokument enthaelt XFA-Daten, aber auch dort steht kein Feldwert.');
  }
} else {
  zeile(`  ${ausFeldern.length} Woerter aus Formularfeldern gehen in den Vergleich ein.`);
}
zeile();

await doc.destroy();
