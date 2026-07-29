import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from './errors.js';
import { looksLikePdf } from './validate.js';
import { extractItemStyles } from './pdfStyle.js';

const require = createRequire(import.meta.url);

let pdfjsPromise = null;

/** Lädt pdfjs-dist (Legacy-Build, läuft ohne native Abhängigkeiten in Node). */
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

function standardFontDataUrl() {
  const pkg = require.resolve('pdfjs-dist/package.json');
  return pathToFileURL(path.join(path.dirname(pkg), 'standard_fonts') + path.sep).href;
}

/**
 * Relative Zeichenbreiten für die Positionsschätzung innerhalb eines Textblocks.
 * pdf.js liefert nur die Gesamtbreite eines Textelements; die Wortpositionen darin
 * werden über diese Gewichte geschätzt (deutlich genauer als eine Gleichverteilung).
 */
const NARROW = new Set([...'ijltfIrJ.,;:!|\'`()[]{}/\\-"']);
const WIDE = new Set([...'mwMWQGO@%&']);

function charWeight(char) {
  if (char === ' ' || char === '\t') return 0.5;
  if (NARROW.has(char)) return 0.45;
  if (WIDE.has(char)) return 1.4;
  if (char >= 'A' && char <= 'Z') return 1.15;
  return 1;
}

/** Kumulierte Gewichte je Zeichenposition (Index 0..n). */
export function cumulativeWeights(str) {
  const cumulative = new Array(str.length + 1);
  cumulative[0] = 0;
  for (let i = 0; i < str.length; i += 1) {
    cumulative[i + 1] = cumulative[i] + charWeight(str[i]);
  }
  return cumulative;
}

/**
 * Zerlegt ein pdf.js-TextItem in einzelne Wörter mit geschätzten Bounding-Boxen.
 * Die Box-Koordinaten sind in PDF-Punkten mit Ursprung oben links.
 */
export function itemToWords(item, pageHeight, style = null) {
  const str = item.str ?? '';
  if (str.trim() === '') return [];

  const transform = item.transform || [1, 0, 0, 1, 0, 0];
  const x0 = transform[4];
  const baseline = transform[5];
  const totalWidth = item.width || 0;
  const height = item.height || Math.abs(transform[3]) || 10;
  const top = pageHeight - baseline - height;

  const cumulative = cumulativeWeights(str);
  const totalWeight = cumulative[str.length] || 1;
  const unit = totalWidth / totalWeight;

  const words = [];
  const wordRe = /\S+/g;
  let match;
  while ((match = wordRe.exec(str)) !== null) {
    const start = match.index;
    const text = match[0];
    const end = start + text.length;
    words.push({
      text,
      box: {
        x: round(x0 + cumulative[start] * unit),
        y: round(top),
        width: round(Math.max((cumulative[end] - cumulative[start]) * unit, 1)),
        height: round(Math.max(height, 1)),
      },
      ...(style ? { style } : {}),
      // Merkmale für das Zusammenführen über Elementgrenzen hinweg
      startsAtItemStart: start === 0,
      endsAtItemEnd: end === str.length && !item.hasEOL,
    });
  }
  return words;
}

/**
 * Maximaler Abstand (relativ zur Schrifthöhe), bis zu dem zwei Textelemente noch als
 * dasselbe Wort gelten. Ein echtes Leerzeichen ist in gängigen Schriften 0,25–0,33 em
 * breit; 0,2 em bleibt sicher darunter.
 */
const MAX_WORT_LUECKE = 0.2;

/**
 * Führt Wortteile zusammen, die pdf.js auf mehrere Textelemente verteilt hat.
 *
 * Das passiert regelmäßig bei Sonderzeichen: Wird ein Umlaut aus einer anderen Schrift
 * gesetzt, liefert pdf.js "Selbstst", "ä" und "ndige(r)" als drei Elemente. Ohne
 * Zusammenführung entstünde daraus "Selbstst ä ndige(r)" – und damit eine gemeldete
 * Abweichung, obwohl der Text identisch ist.
 */
export function mergeWordFragments(words) {
  const merged = [];

  for (const word of words) {
    const vorheriges = merged[merged.length - 1];
    if (vorheriges && gehoertZusammen(vorheriges, word)) {
      vorheriges.text += word.text;
      const rechts = Math.max(
        vorheriges.box.x + vorheriges.box.width,
        word.box.x + word.box.width
      );
      vorheriges.box.x = Math.min(vorheriges.box.x, word.box.x);
      vorheriges.box.width = round(rechts - vorheriges.box.x);
      vorheriges.box.y = Math.min(vorheriges.box.y, word.box.y);
      vorheriges.box.height = round(Math.max(vorheriges.box.height, word.box.height));
      vorheriges.endsAtItemEnd = word.endsAtItemEnd;
      continue;
    }
    merged.push({ ...word, box: { ...word.box } });
  }

  // Hilfsmerkmale entfernen – sie gehören nicht ins Ergebnis.
  return merged.map(({ startsAtItemStart, endsAtItemEnd, ...rest }) => rest);
}

function gehoertZusammen(links, rechts) {
  if (!links.endsAtItemEnd || !rechts.startsAtItemStart) return false;

  const hoehe = Math.min(links.box.height, rechts.box.height) || 1;
  // Gleiche Zeile? (y ist die Oberkante; unterschiedliche Schriften weichen leicht ab)
  if (Math.abs(links.box.y - rechts.box.y) > hoehe * 0.35) return false;

  const luecke = rechts.box.x - (links.box.x + links.box.width);
  return luecke <= hoehe * MAX_WORT_LUECKE && luecke >= -hoehe * 0.6;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Unsichtbare Steuerzeichen (weiches Trennzeichen, Zero-Width-Zeichen, BOM) entfernen und
 * die Schreibweise vereinheitlichen (NFC). Ohne die Normalisierung gilt ein zerlegtes
 * "a" + Trema nicht als dasselbe Zeichen wie ein zusammengesetztes "ä".
 */
export function cleanText(text) {
  return String(text)
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
    .normalize('NFC');
}

/**
 * Extrahiert Text inkl. Positionen seitenweise aus einem PDF-Buffer.
 * @returns {Promise<{pageCount:number, pages:Array<{pageNumber:number,width:number,height:number,text:string,words:Array}>}>}
 */
export async function extractPages(buffer, { label = 'PDF' } = {}) {
  if (!looksLikePdf(buffer)) {
    throw new AppError('INVALID_PDF', `${label} ist kein gültiges PDF-Dokument.`, { status: 400 });
  }

  const pdfjs = await getPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(Buffer.from(buffer)),
      standardFontDataUrl: standardFontDataUrl(),
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch (err) {
    throw new AppError(
      'PDF_PARSE_FAILED',
      `${label} konnte nicht gelesen werden: ${err?.message || 'unbekannter Fehler'}. ` +
        'Möglicherweise ist die Datei beschädigt oder passwortgeschützt.',
      { status: 400, cause: err }
    );
  }

  const pages = [];
  let colorsResolved = true;
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      // Schriftart, -größe, -schnitt und Farbe je Textelement (für den Stilvergleich).
      const styleInfo = await extractItemStyles(page, content.items, pdfjs);
      if (!styleInfo.colorsResolved) colorsResolved = false;

      const rohWorte = [];
      content.items.forEach((item, index) => {
        if (typeof item.str !== 'string') return;
        rohWorte.push(...itemToWords(item, viewport.height, styleInfo.styles[index] ?? null));
      });

      // Über Elementgrenzen getrennte Wortteile wieder zusammenführen (Sonderzeichen)
      // und unsichtbare Steuerzeichen entfernen.
      const words = mergeWordFragments(rohWorte)
        .map((word) => ({ ...word, text: cleanText(word.text) }))
        .filter((word) => word.text !== '');

      pages.push({
        pageNumber,
        width: round(viewport.width),
        height: round(viewport.height),
        text: words.map((w) => w.text).join(' '),
        words,
      });
      page.cleanup();
    }
  } finally {
    await doc.destroy?.();
  }

  return { pageCount: pages.length, pages, colorsResolved };
}
