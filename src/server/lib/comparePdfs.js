import { extractPages } from './pdfText.js';
import { diffTokens, similarity } from './diff.js';

/** Farbcodes für die Hervorhebung in der UI (FR6). */
export const HIGHLIGHT_COLORS = {
  removed: '#e5484d', // nur in der Referenz vorhanden -> rot
  added: '#e5484d', // nur im generierten PDF vorhanden -> rot
  missingPage: '#e5484d',
};

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

  const removed = [];
  const added = [];
  for (const op of ops) {
    if (op.type === 'removed') {
      const word = refWords[op.aIndex];
      removed.push({ ...word.box, text: word.text, type: 'removed' });
    } else if (op.type === 'added') {
      const word = genWords[op.bIndex];
      added.push({ ...word.box, text: word.text, type: 'added' });
    }
  }

  const mergedRemoved = mergeBoxes(removed);
  const mergedAdded = mergeBoxes(added);
  const identical = removed.length === 0 && added.length === 0;

  return {
    pageNumber: referencePage?.pageNumber ?? generatedPage?.pageNumber,
    status: identical ? 'equal' : 'different',
    identical,
    similarity: similarity(ops),
    referencePresent: Boolean(referencePage),
    generatedPresent: Boolean(generatedPage),
    reference: referencePage
      ? { width: referencePage.width, height: referencePage.height, highlights: mergedRemoved }
      : null,
    generated: generatedPage
      ? { width: generatedPage.width, height: generatedPage.height, highlights: mergedAdded }
      : null,
    counts: { removedWords: removed.length, addedWords: added.length },
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

    const onlyIn = referencePage ? 'reference' : 'generated';
    const page = referencePage ?? generatedPage;
    const highlights = mergeBoxes(page.words.map((w) => ({ ...w.box, text: w.text, type: 'page-missing' })));
    pages.push({
      pageNumber: index + 1,
      status: onlyIn === 'reference' ? 'only-in-reference' : 'only-in-generated',
      identical: false,
      similarity: 0,
      referencePresent: Boolean(referencePage),
      generatedPresent: Boolean(generatedPage),
      reference: referencePage ? { width: page.width, height: page.height, highlights } : null,
      generated: generatedPage ? { width: page.width, height: page.height, highlights } : null,
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
