import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { isSymbolFont, isSymbolGlyph, verwerfeUnplausibleSymbole } from '../src/server/lib/pdfStyle.js';
import { extractPages, markiereMarkierungsschriften } from '../src/server/lib/pdfText.js';
import {
  makeCheckboxPdf,
  makeSimplePdf,
  makeEmbeddedFontPdf,
  makeMarkerFontPdf,
} from './helpers/rawPdf.mjs';
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

/**
 * Eingebettete Subset-Schriften bilden normale Buchstaben in den Private-Use-Bereich ab.
 * Würden diese als Symbol gelten, verschwände sämtlicher Text aus dem Vergleich und es
 * würden gar keine Abweichungen mehr gemeldet.
 */
test('Symbol-Glyph: Private-Use-Bereich gilt nicht als Symbol', () => {
  assert.equal(isSymbolGlyph({ fontChar: '', unicode: 'A' }), false, 'PUA ist kein Symbol');
  assert.equal(isSymbolGlyph({ fontChar: '', unicode: 'e' }), false, 'PUA ist kein Symbol');
  assert.equal(isSymbolGlyph({ fontChar: '', unicode: 'x' }), false, 'PUA ist kein Symbol');
});

test('Symbol-Glyph: Eingebettete Schriften bleiben normaler Text', async () => {
  const { pages } = await extractPages(await makeEmbeddedFontPdf(['Rechnung 4711', 'Betrag 100 EUR']));

  assert.ok(pages[0].words.length > 0, 'Es muss Text erkannt werden');
  assert.deepEqual(
    pages[0].words.filter((w) => w.symbol).map((w) => w.text),
    [],
    'Kein Wort einer eingebetteten Textschrift darf als Symbol gelten'
  );
  assert.equal(pages[0].text, 'Rechnung 4711 Betrag 100 EUR');
});

test('Symbol-Glyph: Abweichungen in eingebetteten Schriften werden gemeldet', async () => {
  const referenz = await makeEmbeddedFontPdf(['Rechnung 4711', 'Betrag 100 EUR']);
  const generiert = await makeEmbeddedFontPdf(['Rechnung 4711', 'Betrag 999 EUR']);

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, false, 'Die echte Abweichung wurde verschluckt');
  assert.equal(ergebnis.symbolGlyphs.count, 0, 'Es darf nichts als Symbol ausgefiltert werden');
  assert.equal(ergebnis.markdown.identical, false, 'Auch der Markdown-Vergleich muss sie melden');
  assert.ok(
    ergebnis.pages[0].generated.highlights.some((box) => box.text.includes('999')),
    'Der geänderte Betrag fehlt in den Markierungen'
  );
});

test('Symbol-Glyph: Überschießender Erkennung wird nicht vertraut', () => {
  const items = [{ str: 'Alpha' }, { str: 'Beta' }, { str: 'Gamma' }, { str: 'Delta' }];

  // Vereinzelte Symbole bleiben erhalten …
  assert.deepEqual(verwerfeUnplausibleSymbole([true, false, false, false], items), [
    true,
    false,
    false,
    false,
  ]);

  // … eine Seite, die überwiegend als Symbol gilt, wird verworfen.
  assert.deepEqual(verwerfeUnplausibleSymbole([true, true, true, false], items), [
    false,
    false,
    false,
    false,
  ]);
  assert.deepEqual(verwerfeUnplausibleSymbole([true, true, true, true], items), [
    false,
    false,
    false,
    false,
  ]);

  // Genau die Hälfte gilt noch als plausibel.
  assert.deepEqual(verwerfeUnplausibleSymbole([true, true, false, false], items), [
    true,
    true,
    false,
    false,
  ]);
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

  // Die Einzelbuchstaben-Regel würde die Kästchen ohnehin entfernen – hier geht es
  // ausschließlich um die Symbolerkennung, deshalb ist sie mit abgeschaltet.
  const ergebnis = await comparePdfs(referenz, generiert, {
    ignoreSymbols: false,
    ignoreSingleLetters: false,
  });

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
        ...(ignoreSymbols === undefined ? {} : { ignoreSymbols, ignoreSingleLetters: false }),
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

/**
 * Dritte, vollständig fontname- und glyphunabhängige Erkennung: Eine Schrift, die im ganzen
 * Dokument ausschließlich einzelne, sich wiederholende Zeichen setzt, kann keine Textschrift
 * sein – sie setzt Markierungen (Kästchen, Haken). Genau diesen Fall liefern echte
 * Formulargeneratoren: Die Kästchenschrift heißt nichtssagend ("AAAAAA+F2") und der
 * gezeichnete Glyph ist von einem gewöhnlichen Buchstaben nicht zu unterscheiden.
 */
const wort = (text, font) => ({ text, style: { font, bold: false, italic: false } });
const alsSymbol = (...woerter) =>
  markiereMarkierungsschriften([{ words: woerter }])[0].words.filter((w) => w.symbol).map((w) => w.text);

test('Markierungsschrift: Kästchen ohne erkennbaren Schriftnamen werden erkannt', async () => {
  const { pages } = await extractPages(makeMarkerFontPdf(OPTIONEN));

  const marken = pages[0].words.filter((w) => w.symbol);
  assert.equal(marken.length, OPTIONEN.length, 'Jedes Kästchen muss erkannt werden');
  assert.deepEqual([...new Set(marken.map((w) => w.text))], ['A']);
  assert.ok(
    pages[0].words.some((w) => w.text === 'einmalig' && !w.symbol),
    'Der Fließtext darf nicht betroffen sein'
  );
});

test('Markierungsschrift: Fehlende Kästchen erzeugen keine Abweichung', async () => {
  const ergebnis = await comparePdfs(
    makeMarkerFontPdf(OPTIONEN, { mitMarken: true }),
    makeMarkerFontPdf(OPTIONEN, { mitMarken: false })
  );

  assert.equal(ergebnis.identical, true, 'Der sichtbare Text ist gleich');
  assert.equal(ergebnis.markdown.identical, true, 'Visueller und Markdown-Vergleich müssen übereinstimmen');
  assert.deepEqual(ergebnis.pages[0].generated.highlights, []);
  assert.equal(ergebnis.symbolGlyphs.count, OPTIONEN.length);
  assert.ok(!ergebnis.markdown.reference.includes('A einmalig'), ergebnis.markdown.reference);
});

test('Markierungsschrift: Abgeschaltet werden die Kästchen wieder gemeldet', async () => {
  const ergebnis = await comparePdfs(
    makeMarkerFontPdf(OPTIONEN, { mitMarken: true }),
    makeMarkerFontPdf(OPTIONEN, { mitMarken: false }),
    { ignoreSymbols: false, ignoreSingleLetters: false }
  );

  assert.equal(ergebnis.identical, false);
  assert.equal(ergebnis.pages[0].counts.removedWords, OPTIONEN.length);
});

test('Markierungsschrift: Die Textschrift selbst kann nie betroffen sein', () => {
  // Dieselbe Schrift setzt Fließtext und Einzelzeichen -> keine Markierungsschrift.
  assert.deepEqual(
    alsSymbol(wort('Rechnung', 'Helvetica'), wort('A', 'Helvetica'), wort('A', 'Helvetica')),
    []
  );
});

test('Markierungsschrift: Ziffern in eigener Schrift (Seitenzahlen) bleiben Text', () => {
  assert.deepEqual(
    alsSymbol(wort('Erste Seite', 'Helvetica'), wort('1', 'Seitenzahl'), wort('1', 'Seitenzahl')),
    []
  );
});

test('Markierungsschrift: Einmalige Einzelzeichen (Initialen) bleiben Text', () => {
  assert.deepEqual(
    alsSymbol(wort('Kapitelanfang', 'Helvetica'), wort('A', 'Zierschrift'), wort('B', 'Zierschrift')),
    []
  );
});

test('Markierungsschrift: Über die Hälfte des Dokuments gilt als unplausibel', () => {
  // 3 von 5 Wörtern -> mehr als die Hälfte, also eher Textschrift als Beiwerk.
  assert.deepEqual(
    alsSymbol(
      wort('Erste Zeile', 'Helvetica'),
      wort('Zweite Zeile', 'Helvetica'),
      wort('A', 'Marken'),
      wort('A', 'Marken'),
      wort('A', 'Marken')
    ),
    []
  );
  // 2 von 5 -> plausibel
  assert.deepEqual(
    alsSymbol(
      wort('Erste Zeile', 'Helvetica'),
      wort('Zweite Zeile', 'Helvetica'),
      wort('Dritte Zeile', 'Helvetica'),
      wort('A', 'Marken'),
      wort('A', 'Marken')
    ),
    ['A', 'A']
  );
});

test('Markierungsschrift: Rückfallebene – alleinstehende Einzelbuchstaben ignorieren', async () => {
  // Selbst wenn ein Kästchen in derselben Schrift wie der Fließtext steckt und deshalb von
  // keiner der drei Erkennungen erfasst wird, lässt es sich über diese Option ausblenden.
  const referenz = makeSimplePdf(['A einmalig A gelegentlich']);
  const generiert = makeSimplePdf(['einmalig gelegentlich']);

  const aus = await comparePdfs(referenz, generiert, { ignoreSingleLetters: false });
  assert.equal(aus.identical, false, 'Abgeschaltet bleibt es eine Abweichung');
  assert.deepEqual(aus.singleLetters, { ignored: false, count: 2 });

  const standard = await comparePdfs(referenz, generiert);
  assert.equal(standard.identical, true, 'Standardmäßig greift die Rückfallebene');
  assert.equal(standard.markdown.identical, true);
  assert.deepEqual(standard.singleLetters, { ignored: true, count: 2 });
});

test('Markierungsschrift: Die Oberfläche bietet die Rückfallebene', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');
  const schalter = html.match(/<input[^>]*id="ignore-single-letters"[^>]*>/s)?.[0];

  assert.ok(schalter, 'Schalter für Einzelbuchstaben fehlt');
  assert.match(schalter, /type="checkbox"/);
  assert.match(schalter, /checked/, 'Die Rückfallebene soll standardmäßig greifen');
  assert.match(html, /Alleinstehende Einzelbuchstaben ignorieren/);

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /ignoreSingleLetters: dom\.ignoreSingleLetters\.checked/);
  assert.match(client, /saved\.ignoreSingleLetters/);
  assert.match(client, /singleLetters/, 'Der Hinweis wird nicht angezeigt');
});
