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

/** Textrendermodi, bei denen nichts gezeichnet wird (3 = unsichtbar, 7 = nur Beschnitt). */
const UNSICHTBARE_RENDERMODI = new Set([3, 7]);

/**
 * Liest Farbe, Rendermodus und Deckkraft aus der Operatorliste – **ein Eintrag je
 * gezeichnetem Zeichen** (ohne Leerraum). Diese Angaben sind Teil des Grafikzustands und
 * werden von `q`/`Q` gesichert bzw. zurückgesetzt; der Stack bildet das nach.
 *
 * Die Zuordnung erfolgt bewusst zeichenweise und nicht je Textausgabe: pdf.js zerlegt eine
 * einzelne Textausgabe regelmäßig in mehrere Textelemente, sodass die Anzahlen nicht
 * zusammenpassen. Leerraum bleibt außen vor, weil pdf.js zusätzliche Leerzeichen aus
 * Positionssprüngen erzeugt, denen kein Zeichen im PDF entspricht.
 *
 * Zusätzlich wird je Zeichen erkannt, ob es sich um ein Symbol-/Piktogramm-Glyph handelt,
 * dessen Textwert nur ein Rückfall ist: Weicht der tatsächlich gezeichnete Glyph (`fontChar`)
 * vom gemeldeten Zeichen (`unicode`) ab und ist er selbst kein Buchstabe/Ziffer, stammt die
 * Extraktion aus einer Symbolschrift (z. B. Checkbox-Kästchen, das als "A" ausgegeben wird).
 *
 * @returns {Array<{char:string, state:{color:string, renderMode:number, alpha:number}, symbol:boolean}>}
 */
export function collectTextRenderStates(operatorList, OPS) {
  const zustaende = [];
  let aktuell = { color: '#000000', renderMode: 0, alpha: 1 };
  const stack = [];

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];

    switch (fn) {
      case OPS.save:
        stack.push({ ...aktuell });
        break;
      case OPS.restore:
        if (stack.length > 0) aktuell = stack.pop();
        break;
      case OPS.setFillRGBColor:
        aktuell = { ...aktuell, color: toHexColor([args[0], args[1], args[2]]) };
        break;
      case OPS.setFillGray: {
        const wert = args[0] * 255;
        aktuell = { ...aktuell, color: toHexColor([wert, wert, wert]) };
        break;
      }
      case OPS.setFillCMYKColor:
        aktuell = { ...aktuell, color: toHexColor(cmykToRgb(args)) };
        break;
      case OPS.setTextRenderingMode:
        aktuell = { ...aktuell, renderMode: Number(args[0]) };
        break;
      case OPS.setGState: {
        // args[0] ist eine Liste aus [Name, Wert]; "ca" ist die Fülldeckkraft.
        for (const eintrag of args[0] ?? []) {
          if (Array.isArray(eintrag) && eintrag[0] === 'ca') {
            aktuell = { ...aktuell, alpha: Number(eintrag[1]) };
          }
        }
        break;
      }
      case OPS.showText:
      case OPS.showSpacedText:
        for (const glyph of args[0] ?? []) {
          // Zahlen sind Positionssprünge (Kerning) und zeichnen nichts.
          if (typeof glyph === 'number' || glyph === null) continue;
          const symbol = isSymbolGlyph(glyph);
          for (const zeichen of String(glyph.unicode ?? '')) {
            if (/\s/.test(zeichen)) continue;
            zustaende.push({ char: zeichen, state: aktuell, symbol });
          }
        }
        break;
      default:
        break;
    }
  }

  return zustaende;
}

/**
 * Erkennt ein Symbol-/Piktogramm-Glyph an einem einzelnen pdf.js-Glyph.
 * Der tatsächlich gezeichnete Glyph (`fontChar`) weicht vom gemeldeten Textzeichen
 * (`unicode`) ab und ist selbst kein Buchstabe/keine Ziffer – dann ist der Textwert nur ein
 * Rückfall (z. B. ein Kästchen, das als "A" ausgegeben wird). Ligaturen wie "ﬁ"→"fi" bleiben
 * ausgenommen, da ihr `fontChar` ein Buchstabe ist.
 */
export function isSymbolGlyph(glyph) {
  const fontChar = glyph?.fontChar;
  const unicode = glyph?.unicode;
  if (typeof fontChar !== 'string' || fontChar === '' || fontChar === unicode) return false;
  // Kein Buchstabe/keine Ziffer im gezeichneten Glyph -> Symbol/Piktogramm.
  return !/[\p{L}\p{N}]/u.test(fontChar);
}

/** Wird dieser Zustand überhaupt sichtbar gezeichnet? */
export function isInvisibleState(zustand) {
  if (!zustand) return false;
  return UNSICHTBARE_RENDERMODI.has(zustand.renderMode) || zustand.alpha === 0;
}

/** Wie weit höchstens nach vorn gesucht wird, um ein Textelement im Zeichenstrom zu finden. */
const MAX_SUCHFENSTER = 5000;

/**
 * Ordnet jedem Textelement seinen Zeichenzustand zu.
 *
 * Die Zeichenfolge aus der Operatorliste und die Textelemente stammen aus derselben Quelle,
 * decken sich aber nicht eins zu eins: pdf.js zerlegt Ausgaben in mehrere Elemente und lässt
 * manches weg (z. B. Text außerhalb der Seite), während die Operatorliste alles enthält.
 * Deshalb wird jedes Element als **zusammenhängende Zeichenfolge** im Strom gesucht;
 * Übersprungenes gilt als nicht im Textinhalt enthalten.
 *
 * Ein Element wird nur akzeptiert, wenn sämtliche Zeichen exakt und ohne Lücke passen –
 * eine zufällige Fehlzuordnung ist damit praktisch ausgeschlossen. Findet sich ein Element
 * nicht, wird `null` zurückgegeben und es werden keinerlei Annahmen getroffen.
 *
 * @returns {Array<{state:object, symbol:boolean}|null>|null} je Element der Zeichenzustand und
 *          ob es aus einer Symbolschrift stammt; null, wenn keine Zuordnung möglich ist
 */
export function alignStatesToItems(items, stream) {
  const jeElement = new Array(items.length).fill(null);
  let position = 0;

  for (let index = 0; index < items.length; index += 1) {
    const zeichen = [...String(items[index].str ?? '')].filter((z) => !/\s/.test(z));
    if (zeichen.length === 0) continue;

    let start = -1;
    const grenze = Math.min(stream.length - zeichen.length, position + MAX_SUCHFENSTER);
    for (let kandidat = position; kandidat <= grenze; kandidat += 1) {
      let passt = true;
      for (let k = 0; k < zeichen.length; k += 1) {
        if (stream[kandidat + k].char !== zeichen[k]) {
          passt = false;
          break;
        }
      }
      if (passt) {
        start = kandidat;
        break;
      }
    }

    if (start === -1) return null;
    let symbol = false;
    for (let k = 0; k < zeichen.length; k += 1) {
      if (stream[start + k].symbol) {
        symbol = true;
        break;
      }
    }
    jeElement[index] = { state: stream[start].state, symbol };
    position = start + zeichen.length;
  }

  return jeElement;
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
 * Bekannte Symbol- und Zeichensatzschriften. Zeichen aus diesen Schriften sind keine
 * Buchstaben, sondern Piktogramme (Kästchen, Haken, Pfeile). Da ihnen meist eine
 * Unicode-Zuordnung fehlt, liefert die Textextraktion den rohen Zeichencode – aus einem
 * Checkbox-Kästchen wird so ein "A".
 */
const SYMBOL_FONTS = /wingdings|webdings|dingbats|marlett|monotype ?sorts/i;
const SYMBOL_FAMILY = /(^|[+\-_ ])symbol(mt)?([-_ ,]|$)/i;

/** Erkennt Schriften, deren "Text" in Wahrheit Piktogramme sind. */
export function isSymbolFont(name) {
  if (typeof name !== 'string' || name === '') return false;
  const bereinigt = normalizeFontName(name);
  return SYMBOL_FONTS.test(bereinigt) || SYMBOL_FAMILY.test(bereinigt);
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

  const stream = operatorList ? collectTextRenderStates(operatorList, pdfjs.OPS) : [];
  const zustandJeElement = operatorList ? alignStatesToItems(items, stream) : null;
  // Ohne belastbare Zuordnung werden weder Farben behauptet noch Inhalte ausgeblendet.
  const zuordnungPasst = zustandJeElement !== null;

  const fontCache = new Map();
  const styles = [];
  const invisible = [];
  const symbolGlyph = [];

  items.forEach((item, itemIndex) => {

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

    const zuordnung = zuordnungPasst ? zustandJeElement[itemIndex] : null;
    const zustand = zuordnung?.state ?? null;
    const groesse = fontSizeFromTransform(item.transform);

    styles.push({ ...fontInfo, size: groesse, color: zustand?.color ?? null });
    // Nicht gezeichneter Text: Rendermodus 3/7, Deckkraft 0 oder Schriftgröße 0.
    invisible.push(isInvisibleState(zustand) || groesse === 0);
    // Symbol-/Piktogramm-Glyph, dessen Textwert nur ein Rückfall ist (z. B. Checkbox "A").
    symbolGlyph.push(Boolean(zuordnung?.symbol));
  });

  return { styles, invisible, symbolGlyph, colorsResolved: zuordnungPasst };
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
