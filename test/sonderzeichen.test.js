import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { extractPages, mergeWordFragments, cleanText } from '../src/server/lib/pdfText.js';
import { diffTokens, foldSegmentationDifferences, normalizeToken } from '../src/server/lib/diff.js';
import { makeSimplePdf, makeSplitCharPdf, makeRawTextPdf } from './helpers/rawPdf.mjs';

/**
 * Sonderzeichen sind in PDFs oft abweichend kodiert: Wird ein Umlaut aus einer anderen
 * Schrift gesetzt, liefert pdf.js "Selbstst", "ä" und "ndige(r)" als drei Textelemente.
 * Ohne Behandlung entstünde daraus "Selbstst ä ndige(r)" und damit eine gemeldete
 * Abweichung, obwohl der Text identisch ist.
 */
test('Sonderzeichen: Getrennt kodierte Zeichen ergeben wieder ein Wort', async () => {
  const { pages } = await extractPages(makeSplitCharPdf());

  assert.equal(
    pages[0].text,
    'Selbstständige(r)/Freiberufler(in) Betrag 100 EUR',
    'Das Sonderzeichen wurde nicht mit dem Wort zusammengeführt'
  );
  assert.equal(pages[0].words[0].text, 'Selbstständige(r)/Freiberufler(in)');
});

test('Sonderzeichen: Solche Dokumente gelten als identisch', async () => {
  const referenz = makeSimplePdf(['Selbstständige(r)/Freiberufler(in)', 'Betrag 100 EUR']);
  const generiert = makeSplitCharPdf();

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, true, 'Die Dokumente dürfen nicht als abweichend gelten');
  assert.deepEqual(ergebnis.differingPageNumbers, []);
  assert.deepEqual(ergebnis.pages[0].generated.highlights, [], 'Es darf nichts markiert werden');
  assert.equal(ergebnis.totals.removedWords, 0);
  assert.equal(ergebnis.totals.addedWords, 0);
  assert.equal(ergebnis.markdown.identical, true, 'Auch der Markdown-Vergleich darf nichts melden');
  assert.equal(ergebnis.style.deviations.length, 0, 'Der Stilvergleich darf hier nichts melden');
});

test('Sonderzeichen: Echte Abweichungen werden weiterhin gemeldet', async () => {
  // Gleicher Aufbau, aber ein anderer Umlaut und ein anderer Betrag.
  const referenz = makeSimplePdf(['Selbstständige(r)/Freiberufler(in)', 'Betrag 100 EUR']);
  const generiert = makeRawTextPdf(
    'BT /F1 12 Tf 50 780 Td (Selbstst) Tj /F2 12 Tf (\\366) Tj /F1 12 Tf (ndige\\(r\\)/Freiberufler\\(in\\)) Tj ' +
      '0 -16 Td (Betrag 999 EUR) Tj ET'
  );

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, false, 'Die echte Abweichung wurde verschluckt');
  const markiert = ergebnis.pages[0].generated.highlights.map((box) => box.text);
  assert.ok(
    markiert.some((text) => text.includes('999')),
    `Der geänderte Betrag fehlt in den Markierungen: ${JSON.stringify(markiert)}`
  );
  assert.ok(
    markiert.some((text) => text.includes('ö')),
    `Der geänderte Umlaut fehlt in den Markierungen: ${JSON.stringify(markiert)}`
  );
});

test('Sonderzeichen: Wortteile werden nur bei fehlender Lücke zusammengeführt', () => {
  const basis = { box: { y: 10, height: 12 }, startsAtItemStart: true, endsAtItemEnd: true };

  // Direkt anschließend -> ein Wort
  const zusammen = mergeWordFragments([
    { ...basis, text: 'Selbstst', box: { x: 50, y: 10, width: 42.68, height: 12 } },
    { ...basis, text: 'ä', box: { x: 92.68, y: 10, width: 5.33, height: 12 } },
    { ...basis, text: 'ndige', box: { x: 98.01, y: 10, width: 30, height: 12 } },
  ]);
  assert.equal(zusammen.length, 1);
  assert.equal(zusammen[0].text, 'Selbstständige');
  assert.equal(zusammen[0].box.x, 50);
  assert.equal(zusammen[0].box.width, 78.01, 'Die Box muss beide Teile umfassen');

  // Abstand in Breite eines Leerzeichens (0,28 em) -> zwei Wörter
  const getrennt = mergeWordFragments([
    { ...basis, text: 'Wort', box: { x: 50, y: 10, width: 20, height: 12 } },
    { ...basis, text: 'zwei', box: { x: 73.4, y: 10, width: 20, height: 12 } },
  ]);
  assert.equal(getrennt.length, 2, 'Ein echter Wortabstand darf nicht zusammengeführt werden');

  // Andere Zeile -> zwei Wörter
  const andereZeile = mergeWordFragments([
    { ...basis, text: 'Ende', box: { x: 500, y: 10, width: 20, height: 12 } },
    { ...basis, text: 'Anfang', box: { x: 50, y: 26, width: 20, height: 12 } },
  ]);
  assert.equal(andereZeile.length, 2);

  // Zeilenumbruch im Textelement (hasEOL) -> nicht zusammenführen
  const nachUmbruch = mergeWordFragments([
    { ...basis, text: 'Ende', endsAtItemEnd: false, box: { x: 50, y: 10, width: 20, height: 12 } },
    { ...basis, text: 'Anfang', box: { x: 70, y: 10, width: 20, height: 12 } },
  ]);
  assert.equal(nachUmbruch.length, 2);

  // Hilfsmerkmale gehören nicht ins Ergebnis
  assert.ok(!('startsAtItemStart' in zusammen[0]));
  assert.ok(!('endsAtItemEnd' in zusammen[0]));
});

test('Sonderzeichen: Zerlegte und zusammengesetzte Schreibweise gelten als gleich', () => {
  const zusammengesetzt = 'Selbstst\u00e4ndige'; // "ä" als ein Zeichen
  const zerlegt = 'Selbststa\u0308ndige'; // "a" + kombinierendes Trema

  assert.notEqual(zusammengesetzt, zerlegt, 'Die Testdaten müssen sich roh unterscheiden');
  assert.equal(zerlegt.length, zusammengesetzt.length + 1, 'Die zerlegte Form hat ein Zeichen mehr');
  assert.equal(cleanText(zerlegt), zusammengesetzt);
  assert.equal(normalizeToken(zerlegt), normalizeToken(zusammengesetzt));
});

test('Sonderzeichen: Unsichtbare Zeichen und Leerzeichen-Varianten stören nicht', () => {
  assert.equal(cleanText('Soft­hyphen'), 'Softhyphen');
  assert.equal(cleanText('Zero​width'), 'Zerowidth');
  assert.equal(normalizeToken('geschützt'), 'geschützt');
  assert.equal(normalizeToken('100 EUR'), '100 eur', 'Geschütztes Leerzeichen wird vereinheitlicht');
  assert.equal(normalizeToken('E‑Mail'), normalizeToken('E-Mail'), 'Bindestrich-Varianten');
  assert.equal(normalizeToken('„Zitat“'), normalizeToken('"Zitat"'), 'Anführungszeichen-Varianten');
});

test('Sonderzeichen: Reine Trennungsunterschiede werden als solche erkannt', () => {
  const referenz = ['Selbstständige(r)', 'Betrag'];
  const generiert = ['Selbstst', 'ä', 'ndige(r)', 'Betrag'];

  const ops = foldSegmentationDifferences(diffTokens(referenz, generiert), referenz, generiert);
  assert.ok(
    ops.every((op) => op.type === 'equal' || op.type === 'segmentation'),
    `Es dürfen keine Abweichungen übrig bleiben: ${JSON.stringify(ops.map((o) => o.type))}`
  );

  // Bei echtem Unterschied bleibt es bei einer Abweichung
  const anders = ['Selbstst', 'ö', 'ndige(r)', 'Betrag'];
  const opsAnders = foldSegmentationDifferences(diffTokens(referenz, anders), referenz, anders);
  assert.ok(
    opsAnders.some((op) => op.type === 'removed' || op.type === 'added'),
    'Ein echter Unterschied darf nicht als Trennungsunterschied gelten'
  );
});

test('Sonderzeichen: Auch der Markdown-Vergleich meldet Trennungsunterschiede nicht', async () => {
  const referenz = makeSimplePdf(['Selbstständige(r)/Freiberufler(in)']);
  const generiert = makeSplitCharPdf();

  const { markdown } = await comparePdfs(referenz, generiert);
  const gemeldet = markdown.rows.filter((row) => row.type !== 'equal');
  // Das generierte Dokument hat eine Zeile mehr ("Betrag 100 EUR") – aber keine
  // Meldung wegen der Sonderzeichenzeile.
  assert.ok(
    !gemeldet.some((row) => (row.reference ?? row.generated ?? '').includes('Selbstst')),
    `Die Sonderzeichenzeile darf nicht gemeldet werden: ${JSON.stringify(gemeldet)}`
  );
});
