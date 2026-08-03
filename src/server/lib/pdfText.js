import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from './errors.js';
import { looksLikePdf } from './validate.js';
import { extractItemStyles, isSymbolFont, normalizeFontName, toHexColor } from './pdfStyle.js';
import { xfaFieldValues, xfaLookupName } from './xfa.js';

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
export function itemToWords(item, pageHeight, style = null, invisible = false, symbolGlyph = false) {
  const str = item.str ?? '';
  if (str.trim() === '') return [];

  const transform = item.transform || [1, 0, 0, 1, 0, 0];
  const x0 = transform[4];
  const baseline = transform[5];
  const totalWidth = item.width || 0;
  const height = item.height || Math.abs(transform[3]) || 10;
  const top = pageHeight - baseline - height;

  // Läuft der Text vertikal (um ~90° gedreht)? Dann zeigt die Textrichtung (a,b) stärker
  // nach oben/unten als zur Seite. Solcher Text sind meist seitliche Rahmenvermerke.
  const vertikal = Math.abs(transform[1]) > Math.abs(transform[0]);

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
      // Zeichen aus Symbolschriften sind Piktogramme (Kästchen, Haken), kein Text.
      // Erkennung über den Schriftnamen ODER über den Glyph selbst (gezeichnetes Symbol,
      // dessen Textwert nur ein Rückfall ist – unabhängig vom Fontnamen).
      ...(symbolGlyph || isSymbolFont(style?.font) ? { symbol: true } : {}),
      // Text, der nicht gezeichnet wird (z. B. OCR-Textebene unter einem Scan).
      ...(invisible ? { invisible: true } : {}),
      // Vertikal gedrehter Text (seitliche Rahmenvermerke, Stempel).
      ...(vertikal ? { vertical: true } : {}),
      // Merkmale für das Zusammenführen über Elementgrenzen hinweg
      startsAtItemStart: start === 0,
      endsAtItemEnd: end === str.length && !item.hasEOL,
    });
  }
  return words;
}

/**
 * Wandelt die **Formularfelder** einer Seite in Wörter um.
 *
 * Ausgefüllte Formularfelder (AcroForm) sind kein Bestandteil des Seiteninhalts: Der Wert steht
 * im Feld selbst (`/V`), gezeichnet wird er über einen eigenen Erscheinungsstrom (`/AP`) oder –
 * bei `/NeedAppearances` – erst vom Betrachter. Die Textextraktion sieht davon nichts, weshalb
 * ausgefüllte Felder im Vergleich schlicht fehlten.
 *
 * Der Wert wird deshalb direkt aus dem Feld gelesen. Das ist zugleich der robustere Weg als der
 * Erscheinungsstrom, weil er auch dann funktioniert, wenn gar keiner hinterlegt ist.
 *
 * Die Wortpositionen werden aus dem Feldrechteck geschätzt: Startpunkt links im Feld, Breite je
 * Zeichen aus der Schriftgröße des Feldes. Das genügt für die Hervorhebung; der Textvergleich
 * selbst arbeitet ohnehin über die Reihenfolge.
 */
/**
 * Der Text eines Formularfeldes – bevorzugt so, wie er tatsächlich gezeichnet wird.
 *
 * Zwei Quellen, die beide vorkommen und sich nicht immer decken:
 *
 *  - der **Erscheinungsstrom** (`/AP`), also das, was am Bildschirm steht. Manche Erzeuger
 *    schreiben den Wert ausschließlich dorthin und lassen `/V` leer.
 *  - der **Feldwert** (`/V`). Er ist die einzige Quelle, wenn gar kein Erscheinungsstrom
 *    hinterlegt ist (`/NeedAppearances`) – klassisch der Fall, in dem nur der Acrobat Reader
 *    etwas anzeigt.
 *
 * Vorrang hat das Gezeichnete: Verglichen wird, was zu sehen ist.
 */
function feldwert(annotation, annotationTexts, xfaWerte) {
  const gezeichnet = annotationTexts.get(annotation.id);
  if (typeof gezeichnet === 'string' && gezeichnet.trim() !== '') {
    return { text: gezeichnet, quelle: 'appearance' };
  }

  const wert = Array.isArray(annotation.fieldValue)
    ? annotation.fieldValue.join(' ')
    : annotation.fieldValue;
  if (typeof wert === 'string' && wert.trim() !== '') return { text: wert, quelle: 'value' };

  const ausXfa = xfaWerte?.get(xfaLookupName(annotation.fieldName));
  return typeof ausXfa === 'string' && ausXfa.trim() !== '' ? { text: ausXfa, quelle: 'xfa' } : null;
}

export function annotationsToWords(annotations, viewport, annotationTexts = new Map(), xfaWerte = new Map()) {
  const words = [];

  for (const annotation of annotations ?? []) {
    if (annotation?.subtype !== 'Widget') continue;
    // Nur textführende Felder: Textfelder (Tx) und Auswahllisten (Ch). Ankreuzfelder (Btn)
    // tragen keinen Text, sondern einen technischen Wert ("Off", "1") – der hat im
    // Textvergleich nichts verloren, genau wie ein gezeichnetes Kästchen.
    if (annotation.fieldType !== 'Tx' && annotation.fieldType !== 'Ch') continue;

    const quelle = feldwert(annotation, annotationTexts, xfaWerte);
    if (quelle === null) continue;
    const wert = quelle.text;

    const [x1, y1, x2, y2] = annotation.rect ?? [0, 0, 0, 0];
    const links = Math.min(x1, x2);
    const feldBreite = Math.abs(x2 - x1);
    const feldHoehe = Math.abs(y2 - y1);
    const oben = viewport.height - Math.max(y1, y2);

    const groesse = Number(annotation.defaultAppearanceData?.fontSize) || 0;
    // Schriftgröße 0 heißt im PDF "automatisch an die Feldhöhe anpassen".
    const schriftgroesse = groesse > 0 ? groesse : Math.max(feldHoehe * 0.7, 6);
    const style = {
      font: normalizeFontName(annotation.defaultAppearanceData?.fontName) || 'Formularfeld',
      size: Math.round(schriftgroesse * 100) / 100,
      bold: false,
      italic: false,
      color: annotation.defaultAppearanceData?.fontColor
        ? toHexColor([...annotation.defaultAppearanceData.fontColor])
        : null,
    };

    const zeilen = String(wert).split(/\r\n|\r|\n/);
    zeilen.forEach((zeile, zeilenIndex) => {
      if (zeile.trim() === '') return;
      const cumulative = cumulativeWeights(zeile);
      // Umrechnung Gewicht -> Punkte. Der Faktor ist an Helvetica geeicht: Die Gewichte aus
      // cumulativeWeights ergeben für einen typischen Satz rund 0,58 × Schriftgröße je Einheit.
      const einheit = schriftgroesse * 0.58;
      const zeilenOben = oben + zeilenIndex * schriftgroesse * 1.15;

      const wordRe = /\S+/g;
      let match;
      while ((match = wordRe.exec(zeile)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const x = links + 2 + cumulative[start] * einheit;
        words.push({
          text: match[0],
          box: {
            x: round(Math.min(x, links + feldBreite)),
            y: round(zeilenOben),
            width: round(
              Math.max(Math.min((cumulative[end] - cumulative[start]) * einheit, feldBreite), 1)
            ),
            height: round(Math.max(Math.min(schriftgroesse * 1.2, feldHoehe || Infinity), 1)),
          },
          style,
          // Ausgeblendete Felder werden nicht gezeichnet – wie unsichtbarer Text im Inhalt.
          ...(annotation.hidden ? { invisible: true } : {}),
          formField: true,
          // Woher der Wert stammt. Nur "xfa" wird von keinem Betrachter gezeichnet – die
          // Oberfläche setzt solche Werte deshalb selbst in die Seitenansicht ein.
          formSource: quelle.quelle,
        });
      }
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
  // Ein Piktogramm gehört nie zum benachbarten Wort.
  if (Boolean(links.symbol) !== Boolean(rechts.symbol)) return false;
  // Sichtbares und unsichtbares darf nicht zu einem Wort verschmelzen.
  if (Boolean(links.invisible) !== Boolean(rechts.invisible)) return false;
  // Vertikaler und horizontaler Text gehören nicht zusammen.
  if (Boolean(links.vertical) !== Boolean(rechts.vertical)) return false;

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
 * Liegt die Box vollständig außerhalb des sichtbaren Seitenbereichs?
 * Eine kleine Toleranz lässt Text am Rand gelten, der nur minimal übersteht.
 */
export function liegtAusserhalb(box, viewport, toleranz = 2) {
  if (!box || !viewport) return false;
  return (
    box.x + box.width <= toleranz ||
    box.y + box.height <= toleranz ||
    box.x >= viewport.width - toleranz ||
    box.y >= viewport.height - toleranz
  );
}

/**
 * Bringt die Wörter in Lesereihenfolge (zeilenweise von oben nach unten, innerhalb einer
 * Zeile von links nach rechts).
 *
 * pdf.js liefert die Wörter in der Reihenfolge, in der das PDF sie zeichnet – und die muss
 * nicht der Lesereihenfolge entsprechen. Werden etwa Checkbox-Kästchen in einem eigenen
 * Durchgang gesetzt, steht im einen Dokument erst die untere, dann die obere Zeile. Ohne
 * Normalisierung meldet der Wortvergleich dann Abweichungen, obwohl der Inhalt identisch
 * ist – während der Markdown-Vergleich, der ohnehin nach Position gruppiert, nichts findet.
 */
export function sortInReadingOrder(words) {
  const zeilen = [];

  for (const word of [...words].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
    const toleranz = Math.max(word.box.height * 0.5, 2);
    const zeile = zeilen.find((kandidat) => Math.abs(kandidat.y - word.box.y) <= toleranz);
    if (zeile) {
      zeile.words.push(word);
    } else {
      zeilen.push({ y: word.box.y, words: [word] });
    }
  }

  return zeilen
    .sort((a, b) => a.y - b.y)
    .flatMap((zeile) => zeile.words.sort((a, b) => a.box.x - b.box.x));
}

/**
 * Höchstanteil der Wörter eines Dokuments, den eine Markierungsschrift ausmachen darf.
 * Kästchen und Haken sind Beiwerk; macht eine Schrift mehr als die Hälfte aus, handelt es
 * sich eher um die Textschrift des Dokuments – dann wird nichts ausgeblendet.
 */
const MAX_MARKIERUNGSANTEIL = 0.5;

/** Schriftidentität eines Wortes (Name und Schnitt) – trennt Textschrift von Symbolschrift. */
function fontIdentity(style) {
  if (!style) return 'unbekannt';
  return [style.font, style.bold ? 'b' : '', style.italic ? 'i' : ''].join('|');
}

/**
 * Erkennt **Markierungsschriften** an ihrer Verwendung statt an Namen oder Glyph-Internas.
 *
 * Checkbox-Kästchen kommen aus einer eigenen Schrift, der die Unicode-Zuordnung fehlt: Die
 * Textextraktion liefert dann den rohen Zeichencode, aus dem Kästchen wird ein "A". Weder der
 * Schriftname (oft ein nichtssagendes Subset wie "ABCDEF+F2") noch der gezeichnete Glyph
 * (eingebettete Schriften bilden alles in den Private-Use-Bereich ab) sind dafür verlässlich.
 *
 * Verlässlich ist dagegen, **wie** eine solche Schrift eingesetzt wird. Als Markierungsschrift
 * gilt sie, wenn alle vier Punkte zutreffen:
 *
 *  1. Sie setzt ausschließlich einzelne Zeichen – nie ein Wort aus mehreren Zeichen.
 *  2. Mindestens ein Zeichen wiederholt sich (Kästchen stehen nie allein; das grenzt sie von
 *     einer einzelnen Initiale oder einem Sonderzeichen ab).
 *  3. Sie besteht nicht nur aus Ziffern (sonst träfe es Seitenzahlen in eigener Schrift).
 *  4. Sie macht höchstens die Hälfte des Dokuments aus, und es gibt daneben echten Fließtext.
 *
 * Damit kann die Textschrift eines Dokuments nie betroffen sein – sie setzt zwangsläufig
 * mehrzeichige Wörter. Ein stiller Totalausfall (alles gilt als Symbol, der Vergleich findet
 * nichts mehr) ist so ausgeschlossen.
 */
export function markiereMarkierungsschriften(pages) {
  const jeSchrift = new Map();
  let gesamt = 0;
  let hatFliesstext = false;

  for (const page of pages) {
    for (const word of page.words) {
      const key = fontIdentity(word.style);
      const eintrag = jeSchrift.get(key) ?? { woerter: 0, einzelzeichen: 0, haeufigkeit: new Map() };
      eintrag.woerter += 1;
      const zeichen = [...word.text];
      if (zeichen.length === 1) {
        eintrag.einzelzeichen += 1;
        eintrag.haeufigkeit.set(word.text, (eintrag.haeufigkeit.get(word.text) ?? 0) + 1);
      } else {
        hatFliesstext = true;
      }
      jeSchrift.set(key, eintrag);
      gesamt += 1;
    }
  }

  const markierungsschriften = new Set();
  if (hatFliesstext && gesamt > 0) {
    for (const [key, eintrag] of jeSchrift) {
      const nurEinzelzeichen = eintrag.woerter === eintrag.einzelzeichen;
      const wiederholt = [...eintrag.haeufigkeit.values()].some((anzahl) => anzahl >= 2);
      const nurZiffern = [...eintrag.haeufigkeit.keys()].every((zeichen) => /\p{Nd}/u.test(zeichen));
      if (
        nurEinzelzeichen &&
        wiederholt &&
        !nurZiffern &&
        eintrag.woerter / gesamt <= MAX_MARKIERUNGSANTEIL
      ) {
        markierungsschriften.add(key);
      }
    }
  }

  if (markierungsschriften.size === 0) return pages;

  return pages.map((page) => ({
    ...page,
    words: page.words.map((word) =>
      markierungsschriften.has(fontIdentity(word.style)) ? { ...word, symbol: true } : word
    ),
  }));
}

/** Trennstriche am Zeilenende: Bindestrich, Hyphen, geschützter Bindestrich. */
const TRENNSTRICH = /[-\u2010\u2011]$/;

/**
 * Höchstabstand zweier Zeilen (relativ zur Zeilenhöhe), bis zu dem sie noch als fortlaufender
 * Text gelten. Ein größerer Abstand trennt Absätze oder Tabellenzeilen – über eine solche
 * Lücke hinweg wird nicht zusammengeführt.
 */
const MAX_ZEILENABSTAND = 2.2;

/**
 * Führt Wörter zusammen, die am Zeilenende **getrennt** wurden.
 *
 * Zwei Dokumente mit gleichem Inhalt brechen ihre Zeilen selten an derselben Stelle um. Aus
 * "nichtmilitärischen" wird dann einmal "nichtmi-" + "litärischen" und einmal "nicht-" +
 * "militärischen" – Wort für Wort verglichen sind das vier Abweichungen, obwohl der Text
 * identisch ist. Nach dem Zusammenführen steht in beiden Fassungen dasselbe Wort.
 *
 * Zusammengeführt wird nur, wenn alle Bedingungen zutreffen:
 *  - Das letzte Wort der Zeile endet auf einen Trennstrich, davor steht ein Buchstabe
 *    (schließt "- V" oder "Ausbildungs-/" aus).
 *  - Die Fortsetzung beginnt klein – so bleiben echte Bindestriche in Eigennamen und
 *    Abkürzungen ("E-" / "Mail") unangetastet.
 *  - Die Zeilen folgen unmittelbar aufeinander, ohne größere Lücke.
 *
 * @returns {{words: Array, joined: number}}
 */
export function verbindeTrennungen(words) {
  const zeilen = [];
  for (const word of words) {
    const letzte = zeilen[zeilen.length - 1];
    const toleranz = Math.max(word.box.height * 0.5, 2);
    if (letzte && Math.abs(letzte.y - word.box.y) <= toleranz) letzte.words.push(word);
    else zeilen.push({ y: word.box.y, words: [word] });
  }

  let joined = 0;
  for (let index = 0; index < zeilen.length - 1; index += 1) {
    const letztes = zeilen[index].words[zeilen[index].words.length - 1];
    const erstes = zeilen[index + 1].words[0];
    if (!letztes || !erstes) continue;

    const hoehe = Math.max(letztes.box.height, 1);
    if (zeilen[index + 1].y - zeilen[index].y > hoehe * MAX_ZEILENABSTAND) continue;
    if (!/\p{L}[-\u2010\u2011]$/u.test(letztes.text)) continue;
    if (!/^\p{Ll}/u.test(erstes.text)) continue;
    // Piktogramme und Unsichtbares gehören nie zu einem getrennten Wort.
    if (letztes.symbol || erstes.symbol) continue;
    if (Boolean(letztes.invisible) !== Boolean(erstes.invisible)) continue;

    letztes.text = letztes.text.replace(TRENNSTRICH, '') + erstes.text;
    zeilen[index + 1].words.shift();
    joined += 1;
  }

  return { words: zeilen.flatMap((zeile) => zeile.words), joined };
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

  // Feldwerte aus dem XFA-Teil: letzte Quelle, wenn weder etwas gezeichnet wird noch ein
  // Feldwert gesetzt ist (Hybrid-Formulare, die nur der Acrobat Reader darstellt).
  const xfaWerte = xfaFieldValues(buffer);

  const pages = [];
  let colorsResolved = true;
  let hyphenJoins = 0;
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      // Ausgefüllte Formularfelder stehen nicht im Seiteninhalt und müssen getrennt
      // eingesammelt werden (siehe annotationsToWords).
      let annotations = [];
      try {
        annotations = await page.getAnnotations({ intent: 'display' });
      } catch {
        annotations = [];
      }

      // Schriftart, -größe, -schnitt und Farbe je Textelement (für den Stilvergleich).
      const styleInfo = await extractItemStyles(page, content.items, pdfjs);
      if (!styleInfo.colorsResolved) colorsResolved = false;

      const rohWorte = [];
      content.items.forEach((item, index) => {
        if (typeof item.str !== 'string') return;
        rohWorte.push(
          ...itemToWords(
            item,
            viewport.height,
            styleInfo.styles[index] ?? null,
            styleInfo.invisible[index] === true,
            styleInfo.symbolGlyph?.[index] === true
          )
        );
      });

      // Über Elementgrenzen getrennte Wortteile wieder zusammenführen (Sonderzeichen)
      // und unsichtbare Steuerzeichen entfernen.
      // Reihenfolge: erst zusammenführen (dafür zählt die Zeichenreihenfolge),
      // danach in Lesereihenfolge bringen.
      const formularWorte = annotationsToWords(
        annotations,
        viewport,
        styleInfo.annotationTexts,
        xfaWerte
      );

      // Am Zeilenende getrennte Wörter wieder zusammensetzen – erst in Lesereihenfolge,
      // denn die Fortsetzung steht am Anfang der nächsten Zeile.
      const zusammengefuehrt = verbindeTrennungen(
        sortInReadingOrder(
          [...mergeWordFragments(rohWorte), ...formularWorte]
            .map((word) => ({
              ...word,
              text: cleanText(word.text),
              // Auch außerhalb des Seitenbereichs liegender Text ist nicht sichtbar.
              ...(word.invisible || liegtAusserhalb(word.box, viewport) ? { invisible: true } : {}),
            }))
            .filter((word) => word.text !== '')
        )
      );
      const words = zusammengefuehrt.words;
      hyphenJoins += zusammengefuehrt.joined;

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

  // Erst über das gesamte Dokument hinweg lässt sich erkennen, welche Schrift nur
  // Markierungszeichen (Kästchen, Haken) setzt – dafür braucht es alle Seiten.
  return {
    pageCount: pages.length,
    pages: markiereMarkierungsschriften(pages),
    colorsResolved,
    hyphenJoins,
  };
}
