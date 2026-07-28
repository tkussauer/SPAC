import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { diffTokens, similarity } from '../src/server/lib/diff.js';
import { makePdf, startApp, startMockTarget, uploadReference, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

/** FR5 – Das generierte PDF wird automatisch Seite für Seite mit der Referenz verglichen. */
test('FR5: Identische PDFs werden als identisch erkannt', async () => {
  const pdf = await makePdf([['Rechnung 4711', 'Artikel A'], ['Summe 100 EUR']]);
  const result = await comparePdfs(pdf, pdf);

  assert.equal(result.identical, true);
  assert.equal(result.pageCount.reference, 2);
  assert.equal(result.pageCount.generated, 2);
  assert.equal(result.pages.length, 2);
  assert.deepEqual(result.differingPageNumbers, []);
  assert.ok(result.pages.every((page) => page.status === 'equal'));
});

test('FR5: Abweichungen werden der jeweiligen Seite zugeordnet', async () => {
  const reference = await makePdf([['Rechnung 4711', 'Artikel A'], ['Summe 100 EUR']]);
  const generated = await makePdf([['Rechnung 4711', 'Artikel A'], ['Summe 250 EUR']]);

  const result = await comparePdfs(reference, generated);

  assert.equal(result.identical, false);
  assert.deepEqual(result.differingPageNumbers, [2], 'Nur Seite 2 unterscheidet sich');
  assert.equal(result.pages[0].status, 'equal');
  assert.equal(result.pages[1].status, 'different');
  assert.ok(result.pages[1].similarity < 1);
  assert.equal(result.pages[1].counts.removedWords, 1);
  assert.equal(result.pages[1].counts.addedWords, 1);
});

test('FR5: Unterschiedliche Seitenzahlen werden erkannt und ausgewiesen', async () => {
  const reference = await makePdf([['Seite eins'], ['Seite zwei']]);
  const generated = await makePdf([['Seite eins']]);

  const result = await comparePdfs(reference, generated);

  assert.equal(result.pageCountMatches, false);
  assert.equal(result.pageCount.reference, 2);
  assert.equal(result.pageCount.generated, 1);
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[1].status, 'only-in-reference');
  assert.equal(result.pages[1].generated, null);
  assert.equal(result.identical, false);
});

test('FR5: Der Vergleich läuft automatisch nach dem POST-Aufruf', async () => {
  const reference = await makePdf([['Rechnung 4711', 'Betrag 100 EUR']]);
  const generated = await makePdf([['Rechnung 4711', 'Betrag 999 EUR']]);
  const target = await startMockTarget(() => ({ body: generated }));
  const app = await startApp();

  try {
    const referenceId = await uploadReference(app.url, reference);
    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        referenceId,
      }),
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.ok(result.comparison, 'Es wurde kein Vergleich durchgeführt');
    assert.equal(result.comparison.method, 'text-extraction');
    assert.equal(result.comparison.identical, false);
    assert.deepEqual(result.comparison.differingPageNumbers, [1]);
    assert.equal(result.referenceUrl, `/api/pdf/${referenceId}`);
  } finally {
    await app.close();
    await target.close();
  }
});

test('FR5: Der Wort-Diff arbeitet stabil (LCS)', () => {
  const ops = diffTokens(['a', 'b', 'c'], ['a', 'x', 'c']);
  assert.deepEqual(
    ops.map((op) => op.type),
    ['equal', 'removed', 'added', 'equal']
  );
  assert.equal(similarity(ops), 0.5);
  assert.deepEqual(diffTokens([], []), []);
  assert.equal(similarity(diffTokens(['a'], ['A'])), 1, 'Groß-/Kleinschreibung wird ignoriert');
});
