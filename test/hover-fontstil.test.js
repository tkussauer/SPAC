import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { comparePdfs, textRunsFuerAnsicht } from '../src/server/lib/comparePdfs.js';
import { extractPages } from '../src/server/lib/pdfText.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const STYLED = (doc) => {
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#c00000').text('Ueberschrift');
  doc.font('Helvetica').fontSize(11).fillColor('black').text('Fliesstext');
};

test('Hover: Referenzseite liefert je Text Schriftstil und Farbe (textRuns)', async () => {
  const pdf = await buildStyledPdf(STYLED);
  const { pages } = await extractPages(pdf);
  const runs = textRunsFuerAnsicht(pages[0]);

  const ueberschrift = runs.find((r) => r.text === 'Ueberschrift');
  assert.ok(ueberschrift, 'Text „Ueberschrift" fehlt in den textRuns');
  assert.equal(ueberschrift.font, 'Helvetica-Bold');
  assert.equal(ueberschrift.bold, true);
  assert.equal(ueberschrift.color, '#c00000');
  assert.equal(ueberschrift.size, 18);
  // Jede Position ist gesetzt, damit sich die Hover-Fläche platzieren lässt.
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.equal(typeof ueberschrift[key], 'number');
  }

  const fliesstext = runs.find((r) => r.text === 'Fliesstext');
  assert.equal(fliesstext.color, '#000000');
  assert.equal(fliesstext.bold, false);
});

test('Hover: die Reiter-Geometrie der Referenz enthält textRuns, die des Generats nicht', async () => {
  const pdf = await buildStyledPdf(STYLED);
  const result = await comparePdfs(pdf, pdf);
  const seite = result.pages[0];

  assert.ok(Array.isArray(seite.reference.textRuns), 'reference.textRuns fehlt');
  assert.ok(seite.reference.textRuns.length >= 2);
  // Nur das Referenzdokument bekommt die Hover-Angaben (so lautet die Anforderung).
  assert.equal(seite.generated.textRuns, undefined);
});

test('Hover: Client zeichnet die Hover-Flächen und benennt Stil und Farbe', async () => {
  const js = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  const css = await readFile(path.join(root, 'src/client/styles.css'), 'utf8');

  assert.match(js, /geometry\?\.textRuns/, 'textRuns werden im Client nicht ausgewertet');
  assert.match(js, /class = 'text-style'|className = 'text-style'/, 'Hover-Fläche fehlt');
  assert.match(js, /function beschreibeTextstil/, 'Tooltip-Text wird nicht gebildet');
  assert.match(css, /\.text-style/, 'Kein Stil für die Hover-Fläche');
});
