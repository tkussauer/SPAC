import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { extractPages, annotationsToWords } from '../src/server/lib/pdfText.js';
import { makeFormFieldPdf, makeSimplePdf } from './helpers/rawPdf.mjs';
import { startApp, startMockTarget, uploadReference, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

/**
 * Ausgefüllte Formularfelder (AcroForm) sind **kein Bestandteil des Seiteninhalts**: Der Wert
 * steht im Feld (`/V`), gezeichnet wird er über einen eigenen Erscheinungsstrom (`/AP`) – oder
 * bei `/NeedAppearances` erst vom Betrachter. Die Textextraktion von pdf.js liefert davon
 * nichts, weshalb ausgefüllte Felder im Vergleich schlicht fehlten.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FELDER = [
  { label: 'Name', value: 'Max Mustermann', y: 780 },
  { label: 'Betrag', value: '4711 EUR', y: 750 },
];

test('Formularfelder: Werte landen im extrahierten Text', async () => {
  const { pages } = await extractPages(makeFormFieldPdf(FELDER));

  assert.deepEqual(
    pages[0].words.map((w) => w.text),
    ['Name', 'Max', 'Mustermann', 'Betrag', '4711', 'EUR'],
    'Beschriftung und Feldwert müssen in Lesereihenfolge stehen'
  );
  assert.deepEqual(
    pages[0].words.filter((w) => w.formField).map((w) => w.text),
    ['Max', 'Mustermann', '4711', 'EUR']
  );
});

test('Formularfelder: Auch ohne Erscheinungsstrom', async () => {
  // Ohne /AP kann nur der Betrachter den Wert darstellen (klassisch: nur der Acrobat Reader).
  // Der Wert selbst steht trotzdem im Feld – und genau von dort wird er gelesen.
  for (const varianten of [['ohneAppearance'], ['ohneAppearance', 'needAppearances']]) {
    const { pages } = await extractPages(makeFormFieldPdf(FELDER, varianten));
    assert.ok(
      pages[0].words.some((w) => w.text === 'Mustermann'),
      `Feldwert fehlt bei Variante ${varianten.join('+')}`
    );
  }
});

test('Formularfelder: Abweichende Feldwerte werden gemeldet und markiert', async () => {
  const referenz = makeFormFieldPdf(FELDER);
  const generiert = makeFormFieldPdf([
    { label: 'Name', value: 'Erika Musterfrau', y: 780 },
    { label: 'Betrag', value: '4711 EUR', y: 750 },
  ]);

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, false);
  assert.equal(ergebnis.markdown.identical, false, 'Visueller und Markdown-Vergleich müssen übereinstimmen');
  const markierungen = ergebnis.pages[0].generated.highlights;
  assert.deepEqual(
    markierungen.filter((box) => box.type === 'added').map((box) => box.text),
    ['Erika Musterfrau']
  );
  assert.deepEqual(
    markierungen.filter((box) => box.type === 'missing').map((box) => box.text),
    ['Max Mustermann']
  );
  assert.equal(ergebnis.formFields.count, 8, 'Beide Dokumente steuern vier Wörter bei');
});

test('Formularfelder: Gleiche Werte erzeugen keine Abweichung', async () => {
  const ergebnis = await comparePdfs(makeFormFieldPdf(FELDER), makeFormFieldPdf(FELDER));
  assert.equal(ergebnis.identical, true);
  assert.equal(ergebnis.markdown.identical, true);
  assert.equal(ergebnis.formFields.count, 8);
});

test('Formularfelder: Ein ausgefülltes Feld gegen fest gesetzten Text', async () => {
  // Der häufige Fall: Die Referenz ist "flachgedrückt" (Werte im Seiteninhalt), das erzeugte
  // Dokument enthält echte Formularfelder. Inhaltlich ist das identisch.
  const referenz = makeSimplePdf(['Name Max Mustermann']);
  const generiert = makeFormFieldPdf([{ label: 'Name', value: 'Max Mustermann', y: 780 }]);

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, true, 'Der sichtbare Inhalt ist derselbe');
  assert.deepEqual(ergebnis.pages[0].generated.highlights, []);
});

test('Formularfelder: Ausgeblendete Felder gelten als nicht sichtbar', async () => {
  const referenz = makeFormFieldPdf(FELDER, ['versteckt']);
  const generiert = makeFormFieldPdf(FELDER, ['versteckt']);

  const { pages } = await extractPages(referenz);
  assert.ok(
    pages[0].words.filter((w) => w.formField).every((w) => w.invisible),
    'Felder mit Hidden-Flag dürfen nicht als sichtbar gelten'
  );

  // Standardmäßig wird Unsichtbares ignoriert – die Feldwerte tauchen im Markdown nicht auf.
  const ergebnis = await comparePdfs(referenz, generiert);
  assert.ok(!ergebnis.markdown.reference.includes('Mustermann'), ergebnis.markdown.reference);
});

test('Formularfelder: Dokumente ohne Felder bleiben unberührt', async () => {
  const pdf = makeSimplePdf(['Ganz normaler Text']);
  const ergebnis = await comparePdfs(pdf, pdf);
  assert.equal(ergebnis.identical, true);
  assert.deepEqual(ergebnis.formFields, { count: 0 });
});

test('Formularfelder: Nur textführende Felder zählen', () => {
  const viewport = { width: 595, height: 842 };
  const feld = (extra) => ({
    subtype: 'Widget',
    rect: [100, 700, 300, 716],
    defaultAppearanceData: { fontSize: 10 },
    ...extra,
  });

  const worte = annotationsToWords(
    [
      feld({ fieldType: 'Tx', fieldValue: 'Text im Feld' }),
      feld({ fieldType: 'Ch', fieldValue: ['Auswahl'] }),
      // Ankreuzfelder tragen einen technischen Wert, keinen Text
      feld({ fieldType: 'Btn', fieldValue: 'Off' }),
      feld({ fieldType: 'Btn', fieldValue: '1' }),
      // Leere Felder liefern nichts
      feld({ fieldType: 'Tx', fieldValue: '' }),
      feld({ fieldType: 'Tx', fieldValue: '   ' }),
      feld({ fieldType: 'Tx' }),
      // Andere Annotationen (z. B. Notizen) sind keine Formularfelder
      { subtype: 'Text', contents: 'Notiz', rect: [0, 0, 10, 10] },
    ],
    viewport
  );

  assert.deepEqual(worte.map((w) => w.text), ['Text', 'im', 'Feld', 'Auswahl']);
});

test('Formularfelder: Mehrzeilige Werte werden zeilenweise gesetzt', () => {
  const worte = annotationsToWords(
    [
      {
        subtype: 'Widget',
        fieldType: 'Tx',
        multiLine: true,
        fieldValue: 'Erste Zeile\nZweite Zeile',
        rect: [100, 700, 300, 740],
        defaultAppearanceData: { fontSize: 10 },
      },
    ],
    { width: 595, height: 842 }
  );

  assert.deepEqual(worte.map((w) => w.text), ['Erste', 'Zeile', 'Zweite', 'Zeile']);
  const [ersteZeile, zweiteZeile] = [worte[0].box.y, worte[2].box.y];
  assert.ok(zweiteZeile > ersteZeile, 'Die zweite Zeile muss unter der ersten liegen');
});

test('Formularfelder: Die Boxen liegen im Feld', () => {
  const worte = annotationsToWords(
    [
      {
        subtype: 'Widget',
        fieldType: 'Tx',
        fieldValue: 'Max Mustermann',
        rect: [200, 777, 460, 793],
        defaultAppearanceData: { fontSize: 10 },
      },
    ],
    { width: 595, height: 842 }
  );

  for (const wort of worte) {
    assert.ok(wort.box.x >= 200, `${wort.text} beginnt links vom Feld`);
    assert.ok(wort.box.x + wort.box.width <= 460 + 1, `${wort.text} ragt rechts aus dem Feld`);
    // Feldoberkante in Bildschirmkoordinaten: 842 - 793 = 49
    assert.ok(Math.abs(wort.box.y - 49) < 1, `${wort.text} sitzt nicht auf Feldhöhe`);
  }
});

test('Formularfelder: Der Vergleich über die API bezieht die Werte ein', async () => {
  const referenz = makeFormFieldPdf(FELDER);
  const generiert = makeFormFieldPdf([
    { label: 'Name', value: 'Erika Musterfrau', y: 780 },
    { label: 'Betrag', value: '4711 EUR', y: 750 },
  ]);
  const target = await startMockTarget(() => ({ body: generiert }));
  const app = await startApp();

  try {
    const referenceId = await uploadReference(app.url, referenz);
    const antwort = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        referenceId,
      }),
    });
    const ergebnis = await antwort.json();

    assert.equal(ergebnis.comparison.identical, false);
    assert.equal(ergebnis.comparison.formFields.count, 8);
    assert.ok(ergebnis.comparison.markdown.generated.includes('Erika Musterfrau'));
  } finally {
    await app.close();
    await target.close();
  }
});

test('Formularfelder: Die Oberfläche weist die einbezogenen Werte aus', async () => {
  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /comparison\.formFields\?\.count/, 'Der Hinweis wird nicht angezeigt');
  assert.match(client, /aus Formularfeldern/);
});

test('Formularfelder: Wert nur im Erscheinungsstrom, /V leer', async () => {
  // Manche Erzeuger schreiben den Wert ausschliesslich in den Erscheinungsstrom. Dann ist der
  // Feldwert keine Quelle mehr – gezeichnet wird er trotzdem, und genau darauf kommt es an.
  const { pages } = await extractPages(makeFormFieldPdf(FELDER, ['nurAppearance']));

  assert.deepEqual(
    pages[0].words.filter((w) => w.formField).map((w) => w.text),
    ['Max', 'Mustermann', '4711', 'EUR']
  );
});

test('Formularfelder: Gezeichneter Wert hat Vorrang vor dem Feldwert', async () => {
  // Weichen Feldwert und Erscheinungsstrom voneinander ab, zaehlt das Sichtbare.
  const referenz = makeFormFieldPdf([{ label: 'Name', value: 'Max Mustermann', y: 780 }], ['nurAppearance']);
  const generiert = makeFormFieldPdf([{ label: 'Name', value: 'Max Mustermann', y: 780 }]);

  const ergebnis = await comparePdfs(referenz, generiert);
  assert.equal(ergebnis.identical, true, 'Beide zeigen denselben Wert an');
});

test('Formularfelder: Gezeichnete Werte einer Annotation zuordnen', async () => {
  const { collectAnnotationTexts } = await import('../src/server/lib/pdfStyle.js');
  const OPS = { beginAnnotation: 80, endAnnotation: 81, showText: 44, showSpacedText: 45 };
  const glyphen = (text) => [[...text].map((unicode) => ({ unicode }))];

  const liste = {
    fnArray: [OPS.showText, OPS.beginAnnotation, OPS.showText, OPS.endAnnotation, OPS.showText],
    argsArray: [glyphen('Seiteninhalt'), ['feld-7'], glyphen('Max Mustermann'), [], glyphen('Rest')],
  };

  const texte = collectAnnotationTexts(liste, OPS);
  assert.deepEqual([...texte.entries()], [['feld-7', 'Max Mustermann']]);

  // Grosse Positionssprünge trennen Wörter (Felder, die jedes Zeichen einzeln setzen).
  const mitSprung = {
    fnArray: [OPS.beginAnnotation, OPS.showSpacedText, OPS.endAnnotation],
    argsArray: [['feld-1'], [[{ unicode: 'A' }, -500, { unicode: 'B' }, -20, { unicode: 'C' }]], []],
  };
  assert.equal(collectAnnotationTexts(mitSprung, OPS).get('feld-1'), 'A BC');
});
