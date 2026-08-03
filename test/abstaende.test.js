import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { extractPages } from '../src/server/lib/pdfText.js';
import { collectLineSpacing, collectSpacingUsage } from '../src/server/lib/pdfStyle.js';
import { collectSpacingInventory, compareSpacing } from '../src/server/lib/styleCompare.js';
import { makeSimplePdf, makeRawTextPdf } from './helpers/rawPdf.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Zwei Dokumente können denselben Wortlaut in denselben Schriften zeigen und trotzdem
 * unterschiedlich gesetzt sein: engerer Zeilenabstand, gesperrter Text. Das fällt weder im
 * Textvergleich noch im Schriftinventar auf.
 */
const wort = (text, y, x = 50, height = 10) => ({ text, box: { x, y, width: 40, height } });

test('Abstände: Zeilenabstand ergibt sich aus den Positionen', () => {
  const abstaende = collectLineSpacing([
    wort('Erste', 100),
    wort('Zweite', 112),
    wort('Dritte', 124),
    wort('Vierte', 136),
  ]);

  assert.deepEqual([...abstaende.entries()], [[12, 3]]);
});

test('Abstände: Absatz- und Spaltenwechsel zählen nicht mit', () => {
  // Großer Sprung (Abschnittswechsel), Einzug (andere Spalte) und abweichende Schriftgröße
  // sagen nichts über den Zeilenabstand aus.
  const abstaende = collectLineSpacing([
    wort('Erste', 100),
    wort('Zweite', 112),
    wort('NachAbsatz', 200),
    wort('Eingerueckt', 212, 120),
    wort('Gross', 224, 50, 20),
  ]);

  assert.deepEqual([...abstaende.entries()], [[12, 1]], 'Nur der echte Zeilenabstand zählt');
});

test('Abstände: Nebeneinanderliegende Blöcke werden nicht verbunden', () => {
  // Zwei Spalten nebeneinander: Die Zeilen überlappen sich waagerecht nicht.
  const abstaende = collectLineSpacing([
    { text: 'Links', box: { x: 50, y: 100, width: 40, height: 10 } },
    { text: 'Rechts', box: { x: 300, y: 112, width: 40, height: 10 } },
  ]);

  assert.equal(abstaende.size, 0);
});

test('Abstände: Zeichen- und Wortabstand kommen aus dem Textzustand', () => {
  const OPS = {
    save: 10,
    restore: 11,
    setCharSpacing: 33,
    setWordSpacing: 34,
    showText: 44,
    showSpacedText: 45,
  };
  const glyphen = (text) => [[...text].map((unicode) => ({ unicode }))];

  const liste = {
    fnArray: [
      OPS.setCharSpacing, OPS.showText,
      OPS.save, OPS.setCharSpacing, OPS.setWordSpacing, OPS.showText, OPS.restore,
      OPS.showText,
    ],
    argsArray: [
      [0], glyphen('abc'),
      [], [1.5], [2], glyphen('de'), [],
      glyphen('fghi'),
    ],
  };

  const { charSpacing, wordSpacing } = collectSpacingUsage(liste, OPS);
  // Nach dem Q gilt wieder der Zustand von davor – der Stack bildet das ab.
  assert.deepEqual([...charSpacing.entries()].sort(), [[0, 7], [1.5, 2]]);
  assert.deepEqual([...wordSpacing.entries()].sort(), [[0, 7], [2, 2]]);
});

test('Abstände: Der Zeilenabstand landet in der Seitenauswertung', async () => {
  const { pages } = await extractPages(
    makeSimplePdf(['Erste Zeile', 'Zweite Zeile', 'Dritte Zeile'])
  );

  const zeilen = Object.fromEntries(pages[0].spacing.line);
  assert.deepEqual(Object.keys(zeilen), ['16'], 'Die Vorlage setzt 16 pt Zeilenabstand');
  assert.equal(zeilen['16'], 2);
});

test('Abstände: Gesperrter Text wird als eigene Variante erkannt', async () => {
  // Tc 2: der zweite Block ist gesperrt gesetzt.
  const pdf = makeRawTextPdf(
    'BT /F1 12 Tf 50 780 Td (Normal gesetzt) Tj ET ' +
      'BT /F1 12 Tf 2 Tc 50 760 Td (Gesperrt gesetzt) Tj ET'
  );
  const { pages } = await extractPages(pdf);

  const zeichen = Object.fromEntries(pages[0].spacing.char);
  assert.ok(zeichen['0'] > 0, `Normaler Abstand fehlt: ${JSON.stringify(zeichen)}`);
  assert.ok(zeichen['2'] > 0, `Sperrung fehlt: ${JSON.stringify(zeichen)}`);
});

test('Abstände: Gegenüberstellung beider Dokumente', () => {
  const seiten = (line) => [{ pageNumber: 1, spacing: { line, char: [[0, 100]], word: [] } }];

  const ergebnis = compareSpacing(seiten([[12, 5]]), seiten([[11, 5]]));

  assert.equal(ergebnis.identical, false);
  assert.equal(ergebnis.totals.onlyInReference, 1);
  assert.equal(ergebnis.totals.onlyInGenerated, 1);

  const nurReferenz = ergebnis.rows.find((row) => row.status === 'only-reference');
  assert.equal(nurReferenz.description, 'Zeilenabstand 12 pt');
  assert.equal(nurReferenz.generated, null);

  const gemeinsam = ergebnis.rows.find((row) => row.kind === 'char');
  assert.equal(gemeinsam.status, 'equal');
  assert.equal(gemeinsam.description, 'Zeichenabstand 0 pt');
});

test('Abstände: Zählung über mehrere Seiten hinweg', () => {
  const inventar = collectSpacingInventory([
    { pageNumber: 1, spacing: { line: [[12, 3]], char: [], word: [] } },
    { pageNumber: 2, spacing: { line: [[12, 2], [14, 1]], char: [], word: [] } },
  ]);

  assert.equal(inventar.get('line|12').count, 5);
  assert.deepEqual([...inventar.get('line|12').pages], [1, 2]);
  assert.equal(inventar.get('line|14').count, 1);
});

test('Abstände: Unterschiedlicher Zeilenabstand fällt im Vergleich auf', async () => {
  const eng = makeRawTextPdf(
    'BT /F1 12 Tf 50 780 Td (Erste Zeile hier) Tj 0 -12 Td (Zweite Zeile hier) Tj ET'
  );
  const weit = makeRawTextPdf(
    'BT /F1 12 Tf 50 780 Td (Erste Zeile hier) Tj 0 -18 Td (Zweite Zeile hier) Tj ET'
  );

  const ergebnis = await comparePdfs(eng, weit);

  assert.equal(ergebnis.identical, true, 'Der Text ist derselbe');
  assert.equal(ergebnis.style.spacing.identical, false, 'Der Zeilenabstand unterscheidet sich');
  assert.equal(ergebnis.style.spacing.totals.onlyInReference, 1);
  assert.equal(ergebnis.style.spacing.totals.onlyInGenerated, 1);
});

test('Abstände: Gleiche Dokumente ergeben gleiche Varianten', async () => {
  const pdf = makeSimplePdf(['Erste Zeile', 'Zweite Zeile']);
  const ergebnis = await comparePdfs(pdf, pdf);

  assert.equal(ergebnis.style.spacing.identical, true);
  assert.ok(ergebnis.style.spacing.rows.every((row) => row.status === 'equal'));
});

test('Abstände: Die Oberfläche zeigt beide Dokumente getrennt', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');

  assert.match(html, /<h2>Abstandsvarianten<\/h2>/, 'Abschnitt für die Abstände fehlt');
  assert.match(html, /id="spacing-reference"/);
  assert.match(html, /id="spacing-generated"/);
  assert.match(html, /id="style-inventory-reference"/);
  assert.match(html, /id="style-inventory-generated"/);
  // Beide Abschnitte stehen nebeneinander.
  assert.equal((html.match(/class="side-by-side"/g) ?? []).length, 2);

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /function renderSpacing/, 'Die Abstände werden nicht gerendert');
  assert.match(client, /dom\.styleInventoryReference/);
  assert.match(client, /dom\.spacingGenerated/);

  const css = await readFile(path.join(root, 'src/client/styles.css'), 'utf8');
  assert.match(css, /\.side-by-side\s*\{[^}]*grid-template-columns:\s*1fr 1fr/s);
});
