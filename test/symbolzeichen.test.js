import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { extractPages } from '../src/server/lib/pdfText.js';
import { isSymbolFont, isSymbolGlyph } from '../src/server/lib/pdfStyle.js';
import { makeCheckboxPdf, makeSimplePdf } from './helpers/rawPdf.mjs';
import { startApp, startMockTarget, uploadReference, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const OPTIONEN = ['einmalig', 'gelegentlich', 'bis zu einer Woche', '2-3 Monate', 'Sonstiges (bitte erläutern)'];

/**
 * Zweite, fontname-unabhängige Erkennung: Ein Checkbox-Glyph wird als Symbol erkannt, weil der
 * tatsächlich gezeichnete Glyph (`fontChar`) vom gemeldeten Textzeichen (`unicode`) abweicht
 * und selbst kein Buchstabe ist – egal, wie die Schrift heißt. Das fängt Checkboxen aus
 * Schriften ab, deren Name nicht auf der Liste bekannter Symbolschriften steht.
 */
test('Symbol-Glyph: Erkennt Piktogramme am Glyph, nicht am Fontnamen', () => {
  // Checkbox: gezeichnet wird ein Symbol, gemeldet wird "A"
  assert.equal(isSymbolGlyph({ fontChar: '✡', unicode: 'A' }), true);
  assert.equal(isSymbolGlyph({ fontChar: '■', unicode: 'A' }), true);
  assert.equal(isSymbolGlyph({ fontChar: '❑', unicode: 'q' }), true);
  // Echter Buchstabe/Ziffer – kein Symbol
  assert.equal(isSymbolGlyph({ fontChar: 'A', unicode: 'A' }), false);
  assert.equal(isSymbolGlyph({ fontChar: '7', unicode: '7' }), false);
  // Ligatur: fontChar ist ein Buchstabe -> kein Symbol
  assert.equal(isSymbolGlyph({ fontChar: 'ﬁ', unicode: 'fi' }), false);
  // Echtes Aufzählungszeichen (fontChar == unicode) -> kein Rückfall, kein Symbol
  assert.equal(isSymbolGlyph({ fontChar: '•', unicode: '•' }), false);
  // Unvollständige Angaben
  assert.equal(isSymbolGlyph({ unicode: 'A' }), false);
  assert.equal(isSymbolGlyph(null), false);
});

/** Genau das gemeldete Beispiel: vorangestelltes Checkbox-"A" vor medizinischen Angaben. */
test('Symbol-Glyph: Checkbox-A vor Listeneinträgen erzeugt keine Markdown-Abweichung', async () => {
  const eintraege = ['Eiweiß im Urin', 'Nierenerkrankung', 'Herzerkrankung', 'Fettstoffwechselstörung'];
  const referenz = makeCheckboxPdf(eintraege, { mitKaestchen: true }); // "A Eiweiß im Urin A Nieren…"
  const generiert = makeCheckboxPdf(eintraege, { mitKaestchen: false }); // ohne Kästchen

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, true, 'Die Checkbox-Zeichen dürfen keine Abweichung erzeugen');
  assert.equal(ergebnis.markdown.identical, true, 'Auch der Markdown-Vergleich darf nichts melden');
  assert.deepEqual(
    ergebnis.markdown.rows.filter((row) => row.type !== 'equal'),
    [],
    'Es darf keine geänderte Markdown-Zeile geben'
  );
  // Der eigentliche Text bleibt im Markdown erhalten, ohne die vorangestellten "A".
  assert.ok(ergebnis.markdown.reference.includes('Eiweiß im Urin Nierenerkrankung'));
  assert.ok(!ergebnis.markdown.reference.includes('A Eiweiß'));
});

/** Die Erkennung greift bereits in der Extraktion (Glyph-Pfad liefert das symbol-Merkmal). */
test('Symbol-Glyph: Das Checkbox-A trägt in der Extraktion das symbol-Merkmal', async () => {
  const { pages } = await extractPages(makeCheckboxPdf(['Eiweiß im Urin'], { mitKaestchen: true }));
  const kaestchen = pages[0].words.filter((w) => w.text === 'A');
  assert.ok(kaestchen.length > 0, 'Das Checkbox-Zeichen fehlt');
  assert.ok(kaestchen.every((w) => w.symbol), 'Das Checkbox-A muss als Symbol markiert sein');
  // Der echte Text bleibt unmarkiert.
  assert.ok(pages[0].words.filter((w) => w.text === 'Eiweiß').every((w) => !w.symbol));
});

/**
 * Checkbox-Kästchen stammen aus Symbolschriften (ZapfDingbats, Wingdings …). Diesen
 * Zeichen fehlt die Unicode-Zuordnung, weshalb die Textextraktion den rohen Zeichencode
 * liefert – aus einem Kästchen wird ein "A". Steht das Kästchen nur im Referenzdokument,
 * entstünde daraus eine gemeldete Abweichung, obwohl der Text identisch ist.
 */
test('Symbolzeichen: Kästchen erscheinen im Rohtext als Buchstabe', async () => {
  const { pages } = await extractPages(makeCheckboxPdf(OPTIONEN));

  assert.equal(
    pages[0].words.map((w) => w.text).join(' '),
    'A einmalig A gelegentlich A bis zu einer Woche A 2-3 Monate A Sonstiges (bitte erläutern)',
    'Der bekannte Extraktionsartefakt wird nicht mehr erzeugt – Test anpassen'
  );

  const symbole = pages[0].words.filter((word) => word.symbol);
  assert.equal(symbole.length, 5, 'Alle fünf Kästchen müssen als Symbolzeichen erkannt sein');
  assert.ok(symbole.every((word) => word.text === 'A'));
  assert.ok(symbole.every((word) => word.style.font === 'ZapfDingbats'));

  // Der eigentliche Text darf nicht fälschlich als Symbol gelten
  assert.ok(pages[0].words.filter((w) => w.text === 'einmalig').every((w) => !w.symbol));
});

test('Symbolzeichen: Fehlen die Kästchen im generierten Dokument, ist das keine Abweichung', async () => {
  const referenz = makeCheckboxPdf(OPTIONEN, { mitKaestchen: true });
  const generiert = makeCheckboxPdf(OPTIONEN, { mitKaestchen: false });

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, true, 'Die Dokumente dürfen nicht als abweichend gelten');
  assert.deepEqual(ergebnis.pages[0].generated.highlights, [], 'Es darf nichts markiert werden');
  assert.equal(ergebnis.markdown.identical, true, 'Auch im Markdown darf nichts gemeldet werden');
  assert.deepEqual(
    ergebnis.markdown.rows.filter((row) => row.type !== 'equal'),
    []
  );
  assert.deepEqual(ergebnis.symbolGlyphs, { ignored: true, count: 5 });
});

test('Symbolzeichen: Umgekehrter Fall – Kästchen nur im generierten Dokument', async () => {
  const referenz = makeCheckboxPdf(OPTIONEN, { mitKaestchen: false });
  const generiert = makeCheckboxPdf(OPTIONEN, { mitKaestchen: true });

  const ergebnis = await comparePdfs(referenz, generiert);
  assert.equal(ergebnis.identical, true);
  assert.deepEqual(ergebnis.pages[0].generated.highlights, []);
});

test('Symbolzeichen: Der Markdown-Text enthält die Kästchen nicht mehr', async () => {
  const referenz = makeCheckboxPdf(OPTIONEN, { mitKaestchen: true });
  const generiert = makeCheckboxPdf(OPTIONEN, { mitKaestchen: false });

  const { markdown } = await comparePdfs(referenz, generiert);
  assert.ok(!markdown.reference.includes('A einmalig'), `Kästchen noch im Markdown: ${markdown.reference}`);
  assert.ok(markdown.reference.includes('einmalig gelegentlich'));
  assert.equal(markdown.reference, markdown.generated, 'Beide Textfassungen müssen übereinstimmen');
});

test('Symbolzeichen: Abschaltbar – dann werden die Kästchen wieder gemeldet', async () => {
  const referenz = makeCheckboxPdf(OPTIONEN, { mitKaestchen: true });
  const generiert = makeCheckboxPdf(OPTIONEN, { mitKaestchen: false });

  const ergebnis = await comparePdfs(referenz, generiert, { ignoreSymbols: false });

  assert.equal(ergebnis.identical, false);
  assert.equal(ergebnis.pages[0].counts.removedWords, 5, 'Die fünf Kästchen fehlen im generierten Dokument');
  assert.equal(ergebnis.symbolGlyphs.ignored, false);
});

test('Symbolzeichen: Echte Textabweichungen bleiben sichtbar', async () => {
  const referenz = makeCheckboxPdf(OPTIONEN, { mitKaestchen: true });
  const geaendert = [...OPTIONEN];
  geaendert[3] = '4-5 Monate';
  const generiert = makeCheckboxPdf(geaendert, { mitKaestchen: false });

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, false, 'Die echte Abweichung wurde verschluckt');
  const markiert = ergebnis.pages[0].generated.highlights.map((box) => box.text);
  assert.ok(
    markiert.some((text) => text.includes('4-5')),
    `Der geänderte Zeitraum fehlt in den Markierungen: ${JSON.stringify(markiert)}`
  );
  // Aber die Kästchen selbst tauchen nicht auf
  assert.ok(!markiert.includes('A'), `Ein Kästchen wurde markiert: ${JSON.stringify(markiert)}`);
});

test('Symbolzeichen: Symbolschriften werden am Namen erkannt', () => {
  for (const name of [
    'ZapfDingbats',
    'Wingdings',
    'Wingdings-Regular',
    'ABCDEF+Wingdings2',
    'Webdings',
    'Symbol',
    'SymbolMT',
    'Marlett',
    'Monotype Sorts',
  ]) {
    assert.equal(isSymbolFont(name), true, `${name} sollte als Symbolschrift gelten`);
  }

  // Normale Textschriften dürfen nicht darunterfallen
  for (const name of ['Helvetica', 'Arial-BoldMT', 'Times-Roman', 'Calibri', 'SymbolaText', 'Symbiosis']) {
    assert.equal(isSymbolFont(name), false, `${name} ist keine Symbolschrift`);
  }
  assert.equal(isSymbolFont(undefined), false);
  assert.equal(isSymbolFont(''), false);
});

test('Symbolzeichen: Ein Kästchen wird nicht mit dem Folgewort verschmolzen', async () => {
  // Ohne Trennung stünden Kästchen und Text direkt nebeneinander.
  const { pages } = await extractPages(makeCheckboxPdf(['einmalig']));
  const woerter = pages[0].words.map((w) => w.text);
  assert.deepEqual(woerter, ['A', 'einmalig'], 'Kästchen und Wort müssen getrennt bleiben');
});

test('Symbolzeichen: Die Einstellung wirkt über die API', async () => {
  const referenz = makeCheckboxPdf(OPTIONEN, { mitKaestchen: true });
  const generiert = makeCheckboxPdf(OPTIONEN, { mitKaestchen: false });
  const target = await startMockTarget(() => ({ body: generiert }));
  const app = await startApp();

  try {
    const referenceId = await uploadReference(app.url, referenz);
    const anfrage = (ignoreSymbols) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        referenceId,
        ...(ignoreSymbols === undefined ? {} : { ignoreSymbols }),
      }),
    });

    // Standard: Symbolzeichen werden ignoriert
    const standard = await (await fetch(`${app.url}/api/generate`, anfrage(undefined))).json();
    assert.equal(standard.comparison.identical, true);
    assert.equal(standard.comparison.symbolGlyphs.ignored, true);

    // Ausgeschaltet: die Kästchen werden gemeldet
    const aus = await (await fetch(`${app.url}/api/generate`, anfrage(false))).json();
    assert.equal(aus.comparison.identical, false);
    assert.equal(aus.comparison.symbolGlyphs.ignored, false);
  } finally {
    await app.close();
    await target.close();
  }
});

test('Symbolzeichen: Dokumente ohne Symbolschrift bleiben unberührt', async () => {
  const pdf = makeSimplePdf(['Ganz normaler Text', 'Zweite Zeile']);
  const ergebnis = await comparePdfs(pdf, pdf);
  assert.equal(ergebnis.identical, true);
  assert.deepEqual(ergebnis.symbolGlyphs, { ignored: true, count: 0 });
});

test('Symbolzeichen: Die Oberfläche bietet den Schalter und weist auf die Wirkung hin', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');
  const schalter = html.match(/<input[^>]*id="ignore-symbols"[^>]*>/s)?.[0];

  assert.ok(schalter, 'Schalter für Symbolzeichen fehlt');
  assert.match(schalter, /type="checkbox"/);
  assert.match(schalter, /checked/, 'Symbolzeichen sollen standardmäßig ignoriert werden');
  assert.match(html, /id="summary-symbols"/, 'Hinweis im Ergebnis fehlt');

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /ignoreSymbols: dom\.ignoreSymbols\.checked/, 'Die Einstellung wird nicht gesendet');
  assert.match(client, /saved\.ignoreSymbols/, 'Die Einstellung wird nicht gespeichert');
  assert.match(client, /symbolGlyphs/, 'Der Hinweis wird nicht angezeigt');
});
