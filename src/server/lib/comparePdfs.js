import { extractPages } from './pdfText.js';
import { diffTokens, foldSegmentationDifferences, similarity } from './diff.js';
import { pagesToMarkdown } from './pdfMarkdown.js';
import { buildLineDiff } from './markdownDiff.js';
import { compareStyles } from './styleCompare.js';

/**
 * Farbcodes für die Hervorhebung in der UI (FR6).
 * Markiert wird ausschließlich im generierten Dokument.
 */
export const HIGHLIGHT_COLORS = {
  added: '#e5484d', // weicht von der Referenz ab -> rot, durchgezogen
  missing: '#e5484d', // steht in der Referenz, fehlt hier -> rot, gestrichelt
};

/**
 * Rechnet eine Box von der Referenzseite auf die Geometrie der generierten Seite um.
 * Nötig, damit fehlender Text an der passenden Stelle im generierten Dokument
 * markiert werden kann, auch wenn die Seitenformate leicht abweichen.
 */
export function projectBox(box, fromPage, toPage) {
  const scaleX = fromPage?.width ? (toPage?.width ?? fromPage.width) / fromPage.width : 1;
  const scaleY = fromPage?.height ? (toPage?.height ?? fromPage.height) / fromPage.height : 1;
  const round = (value) => Math.round(value * 100) / 100;
  return {
    x: round(box.x * scaleX),
    y: round(box.y * scaleY),
    width: round(box.width * scaleX),
    height: round(box.height * scaleY),
  };
}

/** Fasst benachbarte Boxen derselben Zeile zu einer Box zusammen, damit die UI ruhiger wirkt. */
export function mergeBoxes(boxes, { gap = 6 } = {}) {
  const sorted = [...boxes].sort((p, q) => p.y - q.y || p.x - q.x);
  const merged = [];
  for (const box of sorted) {
    const last = merged[merged.length - 1];
    const sameLine = last && Math.abs(last.y - box.y) <= 2 && Math.abs(last.height - box.height) <= 2;
    if (sameLine && box.x - (last.x + last.width) <= gap) {
      const right = Math.max(last.x + last.width, box.x + box.width);
      last.x = Math.min(last.x, box.x);
      last.width = Math.round((right - last.x) * 100) / 100;
      last.text = `${last.text} ${box.text}`.trim();
    } else {
      merged.push({ ...box });
    }
  }
  return merged;
}

/** Entfernt Wörter, auf die das Merkmal zutrifft, aus allen Seiten. Das Prädikat erhält
 *  zusätzlich die Seite, damit positionsabhängige Filter (Kopf-/Fußzeile) möglich sind. */
function withoutWords(dokument, trifftZu) {
  return {
    ...dokument,
    pages: dokument.pages.map((page) => {
      const words = page.words.filter((word) => !trifftZu(word, page));
      return { ...page, words, text: words.map((w) => w.text).join(' ') };
    }),
  };
}

function countWords(dokument, trifftZu) {
  return dokument.pages.reduce((sum, page) => sum + page.words.filter((w) => trifftZu(w, page)).length, 0);
}

/** Umrechnung Millimeter -> PDF-Punkte (1 mm = 72/25,4 pt). */
export const MM_TO_PT = 72 / 25.4;

/**
 * Liefert ein Prädikat, das Wörter im oberen bzw. unteren Randbereich (Kopf-/Fußzeile)
 * erkennt. Maßgeblich ist die vertikale Mitte des Wortes relativ zur jeweiligen Seitenhöhe;
 * so wirkt die Angabe seitenübergreifend auch bei unterschiedlichen Formaten.
 */
export function makeHeaderFooterPredicate(headerMm, footerMm) {
  const headerPt = Math.max(0, Number(headerMm) || 0) * MM_TO_PT;
  const footerPt = Math.max(0, Number(footerMm) || 0) * MM_TO_PT;
  return (word, page) => {
    const mitteY = word.box.y + word.box.height / 2;
    const imKopf = headerPt > 0 && mitteY <= headerPt;
    const imFuss = footerPt > 0 && mitteY >= (page?.height ?? Infinity) - footerPt;
    return imKopf || imFuss;
  };
}

/**
 * Feldwerte, die **kein Betrachter zeichnet**: Sie stehen nur im XFA-Teil eines
 * Hybrid-Formulars. Die Seitenansicht bliebe an dieser Stelle leer, obwohl der Wert zum
 * Dokument gehört – deshalb bekommt die Oberfläche Text und Position, um ihn selbst
 * einzusetzen.
 */
export function nichtGezeichneteFeldwerte(page) {
  return (page?.words ?? [])
    .filter((word) => word.formSource === 'xfa')
    .map((word) => ({ ...word.box, text: word.text }));
}

/** Vergleicht eine einzelne Seite (FR5) und liefert die Hervorhebungsboxen (FR6). */
export function comparePage(referencePage, generatedPage) {
  const refWords = referencePage?.words ?? [];
  const genWords = generatedPage?.words ?? [];
  const refTexte = refWords.map((w) => w.text);
  const genTexte = genWords.map((w) => w.text);
  // Reine Trennungsunterschiede (z. B. abweichend kodierte Sonderzeichen) gelten
  // nicht als Abweichung und werden deshalb nicht markiert.
  const ops = foldSegmentationDifferences(diffTokens(refTexte, genTexte), refTexte, genTexte);

  // Markiert wird ausschließlich im generierten Dokument:
  //  - "added":   Text, der dort steht und von der Referenz abweicht
  //  - "missing": Text der Referenz, der dort fehlt – an die entsprechende
  //               Stelle der generierten Seite projiziert, sonst wäre er unsichtbar
  const missing = [];
  const added = [];
  for (const op of ops) {
    if (op.type === 'removed') {
      const word = refWords[op.aIndex];
      missing.push({
        ...projectBox(word.box, referencePage, generatedPage),
        text: word.text,
        type: 'missing',
      });
    } else if (op.type === 'added') {
      const word = genWords[op.bIndex];
      added.push({ ...word.box, text: word.text, type: 'added' });
    }
  }

  const identical = missing.length === 0 && added.length === 0;
  const highlights = [...mergeBoxes(added), ...mergeBoxes(missing)];

  return {
    pageNumber: referencePage?.pageNumber ?? generatedPage?.pageNumber,
    status: identical ? 'equal' : 'different',
    identical,
    similarity: similarity(ops),
    referencePresent: Boolean(referencePage),
    generatedPresent: Boolean(generatedPage),
    // Die Referenzseite wird ohne Markierungen dargestellt.
    reference: referencePage
      ? {
          width: referencePage.width,
          height: referencePage.height,
          highlights: [],
          formValues: nichtGezeichneteFeldwerte(referencePage),
        }
      : null,
    generated: generatedPage
      ? {
          width: generatedPage.width,
          height: generatedPage.height,
          highlights,
          formValues: nichtGezeichneteFeldwerte(generatedPage),
        }
      : null,
    counts: { removedWords: missing.length, addedWords: added.length },
  };
}

/**
 * Vergleicht zwei PDFs Seite für Seite (FR5) und liefert ein UI-taugliches Ergebnis (FR6).
 * @param {Buffer} referencePdf Referenz-PDF (hochgeladen)
 * @param {Buffer} generatedPdf Vom Zielservice geliefertes PDF
 */
export async function comparePdfs(
  referencePdf,
  generatedPdf,
  {
    ignoreSymbols = true,
    ignoreInvisible = true,
    ignoreHeaderFooter = false,
    headerMm = 25,
    footerMm = 25,
    ignoreVertical = false,
    ignoreSingleLetters = false,
  } = {}
) {
  const [referenceRaw, generatedRaw] = await Promise.all([
    extractPages(referencePdf, { label: 'Das Referenz-PDF' }),
    extractPages(generatedPdf, { label: 'Das generierte PDF' }),
  ]);

  // Zwei Arten von Inhalten, die im Vergleich nichts verloren haben:
  //
  //  - Piktogramme aus Symbolschriften (Checkbox-Kästchen, Haken). Ohne Unicode-Zuordnung
  //    liefert die Extraktion den rohen Zeichencode – aus einem Kästchen wird z. B. ein "A".
  //  - Text, der gar nicht gezeichnet wird: Rendermodus 3/7, Deckkraft 0, Schriftgröße 0
  //    oder Text außerhalb des Seitenbereichs (etwa eine OCR-Ebene unter einem Scan).
  //
  // Steht so etwas nur in einem der Dokumente, entstünde daraus eine gemeldete Abweichung,
  // obwohl sich am sichtbaren Inhalt nichts unterscheidet.
  // Weitere Inhalte, die sich ausblenden lassen:
  //  - Kopf- und Fußzeile (Datum, Seitenzahl, Aktenzeichen), die sich zwangsläufig
  //    unterscheiden.
  //  - Vertikal gedrehter Text – seitliche Rahmenvermerke/Stempel, die inhaltlich nicht zum
  //    Dokument gehören.
  const istSymbol = (word) => Boolean(word.symbol);
  const istUnsichtbar = (word) => Boolean(word.invisible);
  const istVertikal = (word) => Boolean(word.vertical);
  // Rückfallebene, falls eine Markierungsschrift nicht erkannt wird: alleinstehende
  // Einzelbuchstaben ganz ausblenden. Bewusst abschaltbar und standardmäßig aus, denn ein
  // einzelner Buchstabe kann auch echter Inhalt sein (Gliederungspunkt "a)", Initiale).
  const istEinzelbuchstabe = (word) => /^\p{L}$/u.test(word.text);
  const istKopfFuss = ignoreHeaderFooter ? makeHeaderFooterPredicate(headerMm, footerMm) : () => false;
  const auszuschliessen = (word, page) =>
    (ignoreSymbols && istSymbol(word)) ||
    (ignoreInvisible && istUnsichtbar(word)) ||
    (ignoreVertical && istVertikal(word)) ||
    (ignoreSingleLetters && istEinzelbuchstabe(word)) ||
    (ignoreHeaderFooter && istKopfFuss(word, page));

  const reference = withoutWords(referenceRaw, auszuschliessen);
  const generated = withoutWords(generatedRaw, auszuschliessen);
  const symbolWords = countWords(referenceRaw, istSymbol) + countWords(generatedRaw, istSymbol);
  const invisibleWords =
    countWords(referenceRaw, istUnsichtbar) + countWords(generatedRaw, istUnsichtbar);
  const verticalWords = countWords(referenceRaw, istVertikal) + countWords(generatedRaw, istVertikal);
  const formFieldWords =
    countWords(referenceRaw, (word) => Boolean(word.formField)) +
    countWords(generatedRaw, (word) => Boolean(word.formField));
  const singleLetterWords =
    countWords(referenceRaw, istEinzelbuchstabe) + countWords(generatedRaw, istEinzelbuchstabe);
  const headerFooterWords = ignoreHeaderFooter
    ? countWords(referenceRaw, istKopfFuss) + countWords(generatedRaw, istKopfFuss)
    : 0;

  const pageCount = Math.max(reference.pageCount, generated.pageCount);
  const pages = [];

  for (let index = 0; index < pageCount; index += 1) {
    const referencePage = reference.pages[index] ?? null;
    const generatedPage = generated.pages[index] ?? null;

    if (referencePage && generatedPage) {
      pages.push(comparePage(referencePage, generatedPage));
      continue;
    }

    // Seite nur in einem der beiden Dokumente vorhanden.
    // Existiert sie nur im generierten Dokument, gilt ihr gesamter Inhalt als Abweichung;
    // fehlt sie dort, gibt es nichts zu markieren – die Seite wird als fehlend ausgewiesen.
    const page = referencePage ?? generatedPage;
    pages.push({
      pageNumber: index + 1,
      status: referencePage ? 'only-in-reference' : 'only-in-generated',
      identical: false,
      similarity: 0,
      referencePresent: Boolean(referencePage),
      generatedPresent: Boolean(generatedPage),
      reference: referencePage
        ? {
            width: page.width,
            height: page.height,
            highlights: [],
            formValues: nichtGezeichneteFeldwerte(page),
          }
        : null,
      generated: generatedPage
        ? {
            width: page.width,
            height: page.height,
            highlights: mergeBoxes(page.words.map((w) => ({ ...w.box, text: w.text, type: 'added' }))),
            formValues: nichtGezeichneteFeldwerte(page),
          }
        : null,
      counts: {
        removedWords: referencePage ? page.words.length : 0,
        addedWords: generatedPage ? page.words.length : 0,
      },
    });
  }

  // Zusätzliche Textfassung beider Dokumente als Markdown, zeilenweise verglichen.
  const referenceMarkdown = pagesToMarkdown(reference.pages);
  const generatedMarkdown = pagesToMarkdown(generated.pages);
  const lineDiff = buildLineDiff(referenceMarkdown.lines, generatedMarkdown.lines);

  // Schriftarten, -größen, -schnitte und Textfarben gegenüberstellen.
  const style = compareStyles(reference.pages, generated.pages, {
    colorsResolved: reference.colorsResolved !== false && generated.colorsResolved !== false,
  });

  const differingPages = pages.filter((p) => !p.identical);
  return {
    method: 'text-extraction',
    symbolGlyphs: { ignored: ignoreSymbols, count: symbolWords },
    invisibleText: { ignored: ignoreInvisible, count: invisibleWords },
    verticalText: { ignored: ignoreVertical, count: verticalWords },
    // Werte aus ausgefüllten Formularfeldern, die sonst gar nicht im Vergleich auftauchten.
    formFields: { count: formFieldWords },
    // Am Zeilenende getrennte Wörter, die wieder zusammengesetzt wurden.
    hyphenation: { count: (referenceRaw.hyphenJoins ?? 0) + (generatedRaw.hyphenJoins ?? 0) },
    singleLetters: { ignored: ignoreSingleLetters, count: singleLetterWords },
    headerFooter: { ignored: ignoreHeaderFooter, count: headerFooterWords, headerMm, footerMm },
    style,
    markdown: {
      reference: referenceMarkdown.text,
      generated: generatedMarkdown.text,
      rows: lineDiff.rows,
      totals: lineDiff.totals,
      identical: lineDiff.identical,
    },
    identical: differingPages.length === 0 && reference.pageCount === generated.pageCount,
    pageCount: { reference: reference.pageCount, generated: generated.pageCount, compared: pageCount },
    pageCountMatches: reference.pageCount === generated.pageCount,
    differingPageNumbers: differingPages.map((p) => p.pageNumber),
    totals: {
      differingPages: differingPages.length,
      removedWords: pages.reduce((sum, p) => sum + p.counts.removedWords, 0),
      addedWords: pages.reduce((sum, p) => sum + p.counts.addedWords, 0),
    },
    colors: HIGHLIGHT_COLORS,
    pages,
  };
}
