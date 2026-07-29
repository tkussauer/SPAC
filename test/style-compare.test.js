import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { extractPages } from '../src/server/lib/pdfText.js';
import { compareStyles, describeDifferences } from '../src/server/lib/styleCompare.js';
import { cmykToRgb, describeStyle, normalizeFontName, styleKey, toHexColor } from '../src/server/lib/pdfStyle.js';
import { startApp, startMockTarget, uploadReference, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Erzeugt ein PDF mit frei wählbaren Schriften/Farben. */
function buildStyledPdf(spec) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    spec(doc);
    doc.end();
  });
}

test('Stil: Schriftart, -größe, -schnitt und Farbe werden je Wort erkannt', async () => {
  const pdf = await buildStyledPdf((doc) => {
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#c00000').text('Ueberschrift');
    doc.font('Helvetica').fontSize(11).fillColor('black').text('Fliesstext');
    doc.font('Helvetica-Oblique').fontSize(11).text('Kursiv');
    doc.font('Courier').fontSize(9).text('Monospace');
  });

  const { pages } = await extractPages(pdf);
  const stile = Object.fromEntries(pages[0].words.map((word) => [word.text, word.style]));

  assert.deepEqual(stile.Ueberschrift, {
    font: 'Helvetica-Bold',
    bold: true,
    italic: false,
    size: 18,
    color: '#c00000',
  });
  assert.deepEqual(stile.Fliesstext, {
    font: 'Helvetica',
    bold: false,
    italic: false,
    size: 11,
    color: '#000000',
  });
  assert.equal(stile.Kursiv.italic, true);
  assert.equal(stile.Kursiv.font, 'Helvetica-Oblique');
  assert.equal(stile.Monospace.font, 'Courier');
  assert.equal(stile.Monospace.size, 9);
});

test('Stil: Abweichungen bei inhaltlich gleichem Text werden benannt', async () => {
  const reference = await buildStyledPdf((doc) => {
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#c00000').text('Rechnung 4711');
    doc.font('Helvetica').fontSize(11).fillColor('black').text('Betrag 100 EUR');
    doc.text('Kunde Mustermann');
  });
  const generated = await buildStyledPdf((doc) => {
    doc.font('Helvetica').fontSize(14).fillColor('black').text('Rechnung 4711');
    doc.font('Helvetica').fontSize(11).text('Betrag 100 EUR');
    doc.font('Helvetica-Oblique').text('Kunde Mustermann');
  });

  const result = await comparePdfs(reference, generated);
  const style = result.style;

  assert.ok(style, 'Der Stilvergleich fehlt im Ergebnis');
  assert.equal(style.identical, false);
  assert.equal(style.colorsResolved, true);

  const ueberschrift = style.deviations.find((entry) => entry.text.startsWith('Rechnung'));
  assert.ok(ueberschrift, 'Die geänderte Überschrift wurde nicht gemeldet');
  assert.equal(ueberschrift.pageNumber, 1);
  assert.deepEqual(ueberschrift.differences.sort(), ['Fettung', 'Schriftart', 'Schriftgröße', 'Textfarbe'].sort());
  assert.equal(ueberschrift.reference.size, 18);
  assert.equal(ueberschrift.generated.size, 14);
  assert.equal(ueberschrift.reference.color, '#c00000');
  assert.equal(ueberschrift.generated.color, '#000000');

  const kursiv = style.deviations.find((entry) => entry.text.startsWith('Kunde'));
  assert.deepEqual(kursiv.differences.sort(), ['Kursivstellung', 'Schriftart'].sort());
  assert.equal(kursiv.generated.italic, true);

  // Unveränderte Zeile taucht nicht auf
  assert.ok(!style.deviations.some((entry) => entry.text.includes('Betrag')));

  assert.equal(style.totals.byKind['Schriftgröße'], 1);
  assert.equal(style.totals.byKind.Textfarbe, 1);
  assert.deepEqual(style.totals.affectedPages, [1]);
});

test('Stil: Aufeinanderfolgende Wörter mit gleicher Abweichung werden zusammengefasst', async () => {
  const reference = await buildStyledPdf((doc) => doc.font('Helvetica-Bold').fontSize(14).text('Drei Woerter fett'));
  const generated = await buildStyledPdf((doc) => doc.font('Helvetica').fontSize(14).text('Drei Woerter fett'));

  const result = await comparePdfs(reference, generated);
  assert.equal(result.style.deviations.length, 1, 'Es wird ein zusammengefasster Eintrag erwartet');
  assert.equal(result.style.deviations[0].text, 'Drei Woerter fett');
  assert.equal(result.style.deviations[0].words, 3);
});

test('Stil: Das Inventar weist Schriften je Dokument aus', async () => {
  const reference = await buildStyledPdf((doc) => {
    doc.font('Helvetica-Bold').fontSize(18).text('Titel');
    doc.font('Helvetica').fontSize(11).text('Text');
  });
  const generated = await buildStyledPdf((doc) => {
    doc.font('Times-Roman').fontSize(18).text('Titel');
    doc.font('Helvetica').fontSize(11).text('Text');
  });

  const { inventory, totals } = (await comparePdfs(reference, generated)).style;

  const nurReferenz = inventory.find((row) => row.status === 'only-reference');
  assert.match(nurReferenz.description, /Helvetica-Bold 18 pt, fett/);
  assert.equal(nurReferenz.reference.words, 1);
  assert.equal(nurReferenz.generated, null);

  const nurGeneriert = inventory.find((row) => row.status === 'only-generated');
  assert.match(nurGeneriert.description, /Times-Roman 18 pt/);

  const gleich = inventory.find((row) => row.status === 'equal');
  assert.match(gleich.description, /Helvetica 11 pt/);
  assert.equal(gleich.reference.words, gleich.generated.words);
  assert.deepEqual(gleich.reference.pages, [1]);

  assert.equal(totals.fontsOnlyInReference, 1);
  assert.equal(totals.fontsOnlyInGenerated, 1);
});

test('Stil: Identische Dokumente melden keine Abweichung', async () => {
  const pdf = await buildStyledPdf((doc) => {
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#003366').text('Titel');
    doc.font('Helvetica').fontSize(10).fillColor('black').text('Inhalt');
  });

  const result = await comparePdfs(pdf, pdf);
  assert.equal(result.style.identical, true);
  assert.deepEqual(result.style.deviations, []);
  assert.ok(result.style.inventory.every((row) => row.status === 'equal'));
});

test('Stil: Hilfsfunktionen rechnen Farben und Namen korrekt um', () => {
  assert.equal(toHexColor([192, 0, 0]), '#c00000');
  assert.equal(toHexColor([255, 255, 255]), '#ffffff');
  assert.equal(toHexColor([-5, 300, 12.6]), '#00ff0d');
  assert.deepEqual(cmykToRgb([0, 0, 0, 0]), [255, 255, 255]);
  assert.deepEqual(cmykToRgb([0, 0, 0, 1]), [0, 0, 0]);

  // Untergruppen-Präfixe eingebetteter Schriften entfernen
  assert.equal(normalizeFontName('ABCDEF+Arial-BoldMT'), 'Arial-BoldMT');
  assert.equal(normalizeFontName('Helvetica'), 'Helvetica');
  assert.equal(normalizeFontName(undefined), 'unbekannt');

  const stil = { font: 'Arial', size: 12, bold: true, italic: true, color: '#ff0000' };
  assert.equal(describeStyle(stil), 'Arial 12 pt, fett kursiv, #ff0000');
  assert.equal(describeStyle({ font: 'Arial', size: 12, bold: false, italic: false, color: null }), 'Arial 12 pt');
  assert.notEqual(styleKey(stil), styleKey({ ...stil, size: 13 }));
});

test('Stil: describeDifferences benennt nur die tatsächlichen Unterschiede', () => {
  const basis = { font: 'Arial', size: 12, bold: false, italic: false, color: '#000000' };
  assert.deepEqual(describeDifferences(basis, basis), []);
  assert.deepEqual(describeDifferences(basis, { ...basis, size: 14 }), ['Schriftgröße']);
  assert.deepEqual(describeDifferences(basis, { ...basis, bold: true }), ['Fettung']);
  // Fehlt die Farbe in einem Dokument, wird sie nicht als Unterschied gewertet.
  assert.deepEqual(describeDifferences(basis, { ...basis, color: null }), []);
});

test('Stil: Ohne Stilangaben bleibt der Vergleich ohne Abweichungen', () => {
  const seiten = [{ pageNumber: 1, words: [{ text: 'A', box: {} }] }];
  const ergebnis = compareStyles(seiten, seiten, { colorsResolved: false });
  assert.deepEqual(ergebnis.deviations, []);
  assert.deepEqual(ergebnis.inventory, []);
  assert.equal(ergebnis.colorsResolved, false);
});

test('Stil: Der Vergleich steht über die API bereit', async () => {
  const reference = await buildStyledPdf((doc) => doc.font('Helvetica-Bold').fontSize(14).text('Rechnung 4711'));
  const generated = await buildStyledPdf((doc) => doc.font('Helvetica').fontSize(14).text('Rechnung 4711'));
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

    assert.ok(result.comparison.style, 'Die API liefert keinen Stilvergleich');
    assert.equal(result.comparison.style.deviations.length, 1);
    assert.deepEqual(result.comparison.style.deviations[0].differences, ['Schriftart', 'Fettung']);
    // Der reine Textvergleich meldet hier keine Abweichung – nur die Formatierung unterscheidet sich.
    assert.equal(result.comparison.identical, true);
  } finally {
    await app.close();
    await target.close();
  }
});

test('Stil: Die Oberfläche stellt den Vergleich über einen dritten Reiter bereit', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');

  assert.match(html, /id="tab-style"[^>]*aria-controls="style-panel"/s, 'Reiter für den Stilvergleich fehlt');
  assert.match(html, /Font &amp; Stil/, 'Beschriftung des Reiters fehlt');
  assert.match(html, /id="style-panel"[^>]*role="tabpanel"/s, 'Bereich für den Stilvergleich fehlt');
  assert.match(html, /id="style-deviations"/, 'Liste der Abweichungen fehlt');
  assert.match(html, /id="style-inventory"/, 'Schriftinventar fehlt');
  assert.match(html, /id="style-color-hint"/, 'Hinweis zu nicht ermittelbaren Farben fehlt');

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /renderStyleComparison/, 'Der Stilvergleich wird nicht gerendert');
  assert.match(client, /dom\.stylePanel\.hidden = aktiv !== 'style'/, 'Die Ansicht wird nicht umgeschaltet');
  assert.match(client, /const TABS = \['pdf', 'markdown', 'style'\]/, 'Der dritte Reiter fehlt in der Reiterliste');

  const built = await readFile(path.join(root, 'public/app.js'), 'utf8');
  assert.ok(built.includes('style-entry'), 'Im Build fehlt die Stilansicht');
});
