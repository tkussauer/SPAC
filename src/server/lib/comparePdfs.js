import { extractPages } from './pdfText.js';
import { diffTokens, similarity } from './diff.js';

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

/** Vergleicht eine einzelne Seite (FR5) und liefert die Hervorhebungsboxen (FR6). */
export function comparePage(referencePage, generatedPage) {
  const refWords = referencePage?.words ?? [];
  const genWords = generatedPage?.words ?? [];
  const ops = diffTokens(
    refWords.map((w) => w.text),
    genWords.map((w) => w.text)
  );

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
      ? { width: referencePage.width, height: referencePage.height, highlights: [] }
      : null,
    generated: generatedPage
      ? { width: generatedPage.width, height: generatedPage.height, highlights }
      : null,
    counts: { removedWords: missing.length, addedWords: added.length },
  };
}

/**
 * Vergleicht zwei PDFs Seite für Seite (FR5) und liefert ein UI-taugliches Ergebnis (FR6).
 * @param {Buffer} referencePdf Referenz-PDF (hochgeladen)
 * @param {Buffer} generatedPdf Vom Zielservice geliefertes PDF
 */
export async function comparePdfs(referencePdf, generatedPdf) {
  const [reference, generated] = await Promise.all([
    extractPages(referencePdf, { label: 'Das Referenz-PDF' }),
    extractPages(generatedPdf, { label: 'Das generierte PDF' }),
  ]);

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
      reference: referencePage ? { width: page.width, height: page.height, highlights: [] } : null,
      generated: generatedPage
        ? {
            width: page.width,
            height: page.height,
            highlights: mergeBoxes(page.words.map((w) => ({ ...w.box, text: w.text, type: 'added' }))),
          }
        : null,
      counts: {
        removedWords: referencePage ? page.words.length : 0,
        addedWords: generatedPage ? page.words.length : 0,
      },
    });
  }

  const differingPages = pages.filter((p) => !p.identical);
  return {
    method: 'text-extraction',
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
