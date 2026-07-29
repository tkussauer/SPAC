import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { extractPages, sortInReadingOrder } from '../src/server/lib/pdfText.js';
import {
  makeSimplePdf,
  makeReversedOrderPdf,
  makeCheckboxPdf,
  makeCheckboxPdfSeparatePass,
} from './helpers/rawPdf.mjs';

/**
 * pdf.js liefert Wörter in der Reihenfolge, in der das PDF sie zeichnet – nicht zwingend in
 * Lesereihenfolge. Ohne Normalisierung meldet der Wortvergleich (und damit die visuelle
 * Ansicht) Abweichungen, obwohl der Inhalt identisch ist. Der Markdown-Vergleich gruppiert
 * ohnehin nach Position und fällt darauf nicht herein – genau diese Diskrepanz war der Fehler.
 */
test('Lesereihenfolge: Wörter werden zeilenweise von oben nach unten sortiert', () => {
  const sortiert = sortInReadingOrder([
    { text: 'zweite', box: { x: 50, y: 30, width: 20, height: 12 } },
    { text: 'B', box: { x: 90, y: 10.5, width: 10, height: 12 } },
    { text: 'A', box: { x: 50, y: 10, width: 10, height: 12 } },
    { text: 'Zeile', box: { x: 80, y: 30, width: 20, height: 12 } },
  ]);

  assert.deepEqual(
    sortiert.map((w) => w.text),
    ['A', 'B', 'zweite', 'Zeile'],
    'Erst die obere Zeile (links nach rechts), dann die untere'
  );
});

test('Lesereihenfolge: Andere Zeichenreihenfolge ergibt dieselbe Wortfolge', async () => {
  const zeilen = ['einmalig gelegentlich', 'selten haeufig'];
  const normal = makeSimplePdf(zeilen);
  const umgekehrt = makeReversedOrderPdf(zeilen);

  const a = await extractPages(normal);
  const b = await extractPages(umgekehrt);

  assert.deepEqual(
    a.pages[0].words.map((w) => w.text),
    b.pages[0].words.map((w) => w.text),
    'Die Zeichenreihenfolge darf die Wortfolge nicht beeinflussen'
  );
});

test('Lesereihenfolge: Visueller Vergleich meldet keine Abweichung mehr', async () => {
  const zeilen = ['einmalig gelegentlich', 'selten haeufig'];
  const ergebnis = await comparePdfs(makeSimplePdf(zeilen), makeReversedOrderPdf(zeilen));

  assert.equal(ergebnis.identical, true, 'Die Dokumente sind inhaltlich identisch');
  assert.deepEqual(
    ergebnis.pages[0].generated.highlights,
    [],
    'Es darf nichts markiert werden'
  );
  // Beide Ansichten müssen zum selben Ergebnis kommen
  assert.equal(ergebnis.markdown.identical, true);
  assert.equal(
    ergebnis.identical,
    ergebnis.markdown.identical,
    'Visueller und Markdown-Vergleich dürfen sich nicht widersprechen'
  );
});

test('Lesereihenfolge: Kästchen in eigenem Zeichendurchgang stören nicht', async () => {
  const optionen = ['einmalig', 'gelegentlich', 'bis zu einer Woche'];
  // Referenz: Kästchen und Text gemischt gezeichnet. Generiert: Kästchen zuerst, dann Text.
  const referenz = makeCheckboxPdf(optionen, { mitKaestchen: true });
  const generiert = makeCheckboxPdfSeparatePass(optionen);

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, true, `Unerwartete Abweichung: ${JSON.stringify(ergebnis.pages[0].generated.highlights)}`);
  assert.deepEqual(ergebnis.pages[0].generated.highlights, []);
  assert.equal(ergebnis.markdown.identical, true);
});

test('Lesereihenfolge: Echte Abweichungen bleiben sichtbar', async () => {
  const ergebnis = await comparePdfs(
    makeSimplePdf(['einmalig gelegentlich', 'selten haeufig']),
    makeReversedOrderPdf(['einmalig gelegentlich', 'selten immer'])
  );

  assert.equal(ergebnis.identical, false, 'Die echte Abweichung wurde verschluckt');
  const markiert = ergebnis.pages[0].generated.highlights.map((box) => box.text);
  assert.ok(markiert.includes('immer'), `Erwartet "immer" in ${JSON.stringify(markiert)}`);
});
