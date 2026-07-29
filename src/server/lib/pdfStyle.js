/**
 * Ermittelt Schriftart, Schriftgröße, Schnitt und Textfarbe der Textelemente einer PDF-Seite.
 *
 * pdf.js liefert im Textinhalt nur generische Angaben ("sans-serif"). Die echten
 * Schriftnamen stehen erst nach `getOperatorList()` in `page.commonObjs`; die Füllfarbe
 * lässt sich ausschließlich aus der Operatorliste ablesen.
 */

/** Rundet auf zwei Nachkommastellen. */
const round = (value) => Math.round(value * 100) / 100;

/** Wandelt einen Farbwert (0..255 je Kanal) in eine Hex-Angabe. */
export function toHexColor([r, g, b]) {
  const channel = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** CMYK (0..1) nach RGB – ausreichend genau für den Vergleich zweier Dokumente. */
export function cmykToRgb([c, m, y, k]) {
  return [255 * (1 - Math.min(1, c + k)), 255 * (1 - Math.min(1, m + k)), 255 * (1 - Math.min(1, y + k))];
}

/**
 * Liest die Textfarben in der Reihenfolge der Textausgaben aus der Operatorliste.
 * @returns {string[]} Hex-Farbe je Textausgabe-Operation
 */
export function collectTextColors(operatorList, OPS) {
  const farben = [];
  let aktuell = '#000000';

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];

    switch (fn) {
      case OPS.setFillRGBColor:
        aktuell = toHexColor([args[0], args[1], args[2]]);
        break;
      case OPS.setFillGray: {
        const wert = args[0] * 255;
        aktuell = toHexColor([wert, wert, wert]);
        break;
      }
      case OPS.setFillCMYKColor:
        aktuell = toHexColor(cmykToRgb(args));
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        farben.push(aktuell);
        break;
      default:
        break;
    }
  }

  return farben;
}

/** Schriftgröße aus der Textmatrix (berücksichtigt gedrehten/skalierten Text). */
export function fontSizeFromTransform(transform = [1, 0, 0, 1, 0, 0]) {
  return round(Math.hypot(transform[0], transform[1]));
}

/** Normalisiert Schriftnamen wie "ABCDEF+Arial-BoldMT" zu "Arial-BoldMT". */
export function normalizeFontName(name) {
  if (typeof name !== 'string' || name === '') return 'unbekannt';
  return name.replace(/^[A-Z]{6}\+/, '');
}

/**
 * Ermittelt die Stilangaben aller Textelemente einer Seite.
 *
 * Farben werden nur dann zugeordnet, wenn die Zahl der Textausgaben exakt zur Zahl der
 * Textelemente passt – andernfalls wäre die Zuordnung geraten und die Farbe bleibt `null`.
 *
 * @returns {Promise<{styles: Array<{font:string,size:number,bold:boolean,italic:boolean,color:string|null}>,
 *                    colorsResolved: boolean}>}
 */
export async function extractItemStyles(page, items, pdfjs) {
  let operatorList = null;
  try {
    // Löst zugleich die Font-Objekte in page.commonObjs auf.
    operatorList = await page.getOperatorList();
  } catch {
    operatorList = null;
  }

  const farben = operatorList ? collectTextColors(operatorList, pdfjs.OPS) : [];
  const sichtbareItems = items.filter((item) => typeof item.str === 'string' && item.str.trim() !== '');
  const farbenPassen = operatorList !== null && farben.length === sichtbareItems.length;

  const fontCache = new Map();
  const styles = [];
  let farbIndex = 0;

  for (const item of items) {
    const sichtbar = typeof item.str === 'string' && item.str.trim() !== '';

    let fontInfo = fontCache.get(item.fontName);
    if (fontInfo === undefined) {
      try {
        const geladen = page.commonObjs.get(item.fontName);
        fontInfo = {
          font: normalizeFontName(geladen?.name || geladen?.fallbackName),
          bold: Boolean(geladen?.bold),
          italic: Boolean(geladen?.italic),
        };
      } catch {
        fontInfo = { font: 'unbekannt', bold: false, italic: false };
      }
      fontCache.set(item.fontName, fontInfo);
    }

    styles.push({
      ...fontInfo,
      size: fontSizeFromTransform(item.transform),
      color: sichtbar && farbenPassen ? farben[farbIndex] : null,
    });

    if (sichtbar) farbIndex += 1;
  }

  return { styles, colorsResolved: farbenPassen };
}

/** Kurzbeschreibung eines Stils für die Anzeige, z. B. "Helvetica-Bold 14 pt, fett, #c00000". */
export function describeStyle(style) {
  if (!style) return 'unbekannt';
  const teile = [`${style.font} ${style.size} pt`];
  const schnitt = [style.bold ? 'fett' : null, style.italic ? 'kursiv' : null].filter(Boolean);
  if (schnitt.length > 0) teile.push(schnitt.join(' '));
  if (style.color) teile.push(style.color);
  return teile.join(', ');
}

/** Eindeutiger Schlüssel eines Stils (für Inventar und Vergleich). */
export function styleKey(style) {
  if (!style) return 'unbekannt';
  return [style.font, style.size, style.bold ? 'b' : '', style.italic ? 'i' : '', style.color ?? '-'].join('|');
}
