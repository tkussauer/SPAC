import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { parseIgnoreWords, withoutIgnoredWords } from '../src/server/lib/ignoreWords.js';
import { makeSimplePdf } from './helpers/rawPdf.mjs';
import { startApp, startMockTarget, uploadReference, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Erzeugte Dokumente enthalten technische Marken, die inhaltlich nichts bedeuten –
 * Ebenenkennungen wie "EBENE-V", Platzhalter, Vermerke des Erzeugers. Sie stehen nur in einem
 * der beiden Dokumente und wären sonst lauter gemeldete Abweichungen.
 */
const worte = (...texte) => texte.map((text) => ({ text }));

test('Ausschluss: Kommagetrennte Liste wird zerlegt', () => {
  const eintraege = parseIgnoreWords('EBENE-V, Daten von S ,  , Entwurf');
  assert.deepEqual(eintraege.map((e) => e.label), ['EBENE-V', 'Daten von S', 'Entwurf']);
  assert.deepEqual(eintraege.map((e) => e.matcher.length), [1, 3, 1]);
});

test('Ausschluss: Führende Markdown-Auszeichnung darf mitkopiert werden', () => {
  // Aus der Markdown-Ansicht kopiert man "### EBENE-V" samt Auszeichnung.
  assert.deepEqual(parseIgnoreWords('### EBENE-V').map((e) => e.label), ['EBENE-V']);
  assert.deepEqual(parseIgnoreWords('- Punkt').map((e) => e.label), ['Punkt']);
  assert.deepEqual(parseIgnoreWords('').map((e) => e.label), []);
  assert.deepEqual(parseIgnoreWords(undefined), []);
});

test('Ausschluss: Einzelne Wörter, unabhängig von der Schreibweise', () => {
  const eintraege = parseIgnoreWords('Entwurf');
  const ergebnis = withoutIgnoredWords(worte('Rechnung', 'ENTWURF', '4711', 'entwurf'), eintraege);

  assert.deepEqual(ergebnis.words.map((w) => w.text), ['Rechnung', '4711']);
  assert.equal(ergebnis.removed, 2);
});

test('Ausschluss: Wortfolgen müssen zusammenhängend vorkommen', () => {
  const eintraege = parseIgnoreWords('Daten von S');

  const treffer = withoutIgnoredWords(worte('Betrag', 'Daten', 'von', 'S', 'Ende'), eintraege);
  assert.deepEqual(treffer.words.map((w) => w.text), ['Betrag', 'Ende']);
  assert.equal(treffer.removed, 3);

  // Auseinandergerissen ist es keine Folge und bleibt stehen.
  const kein = withoutIgnoredWords(worte('Daten', 'Betrag', 'von', 'S'), eintraege);
  assert.equal(kein.removed, 0);
});

test('Ausschluss: Platzhalter erfassen Varianten', () => {
  const eintraege = parseIgnoreWords('EBENE*');
  const ergebnis = withoutIgnoredWords(
    worte('EBENE', 'EBENE-E', 'EBENE-V', 'EBENEN', 'Ebenerdig', 'Rechnung'),
    eintraege
  );

  assert.deepEqual(ergebnis.words.map((w) => w.text), ['Rechnung']);
});

test('Ausschluss: Platzhalter auch in der Mitte und am Anfang', () => {
  const mitte = withoutIgnoredWords(worte('AB-123-CD', 'ABCD'), parseIgnoreWords('AB*CD'));
  assert.deepEqual(mitte.words.map((w) => w.text), []);

  const anfang = withoutIgnoredWords(worte('XY-Ende', 'Ende'), parseIgnoreWords('*Ende'));
  assert.deepEqual(anfang.words.map((w) => w.text), []);
});

test('Ausschluss: Längere Einträge haben Vorrang', () => {
  // Stünde "EBENE" zuerst, bliebe von "EBENE V" das "V" übrig.
  const eintraege = parseIgnoreWords('EBENE, EBENE V');
  const ergebnis = withoutIgnoredWords(worte('EBENE', 'V', 'Rechnung'), eintraege);

  assert.deepEqual(ergebnis.words.map((w) => w.text), ['Rechnung']);
});

test('Ausschluss: Ohne Liste bleibt alles unverändert', () => {
  const eingabe = worte('Rechnung', '4711');
  const ergebnis = withoutIgnoredWords(eingabe, []);
  assert.equal(ergebnis.words, eingabe, 'Ohne Einträge wird nicht einmal kopiert');
  assert.equal(ergebnis.removed, 0);
});

test('Ausschluss: Der Vergleich blendet die Wörter in beiden Dokumenten aus', async () => {
  const referenz = makeSimplePdf(['EBENE-V Rechnung 4711', 'Daten von S Betrag 100 EUR']);
  const generiert = makeSimplePdf(['Rechnung 4711', 'Betrag 100 EUR']);

  const ohne = await comparePdfs(referenz, generiert);
  assert.equal(ohne.identical, false, 'Ohne Liste sind es Abweichungen');

  const mit = await comparePdfs(referenz, generiert, { ignoreWords: '### EBENE*, Daten von S' });
  assert.equal(mit.identical, true);
  assert.equal(mit.markdown.identical, true, 'Auch der Markdown-Vergleich muss stimmen');
  assert.deepEqual(mit.pages[0].generated.highlights, []);
  assert.deepEqual(mit.ignoredWords, { entries: ['EBENE*', 'Daten von S'], count: 4 });
  assert.ok(!mit.markdown.reference.includes('EBENE'), mit.markdown.reference);
});

test('Ausschluss: Echte Abweichungen bleiben erhalten', async () => {
  const referenz = makeSimplePdf(['EBENE-V Betrag 100 EUR']);
  const generiert = makeSimplePdf(['Betrag 999 EUR']);

  const ergebnis = await comparePdfs(referenz, generiert, { ignoreWords: 'EBENE*' });

  assert.equal(ergebnis.identical, false);
  const texte = ergebnis.pages[0].generated.highlights.map((h) => h.text);
  assert.deepEqual(texte.filter((t) => t === '999'), ['999']);
  assert.ok(!texte.some((t) => t.includes('EBENE')), `EBENE wurde gemeldet: ${JSON.stringify(texte)}`);
});

test('Ausschluss: Eine Liste ohne Treffer ändert nichts', async () => {
  const pdf = makeSimplePdf(['Rechnung 4711']);
  const ergebnis = await comparePdfs(pdf, pdf, { ignoreWords: 'kommtnichtvor' });

  assert.equal(ergebnis.identical, true);
  assert.equal(ergebnis.ignoredWords.count, 0);
});

test('Ausschluss: Die Einstellung wirkt über die API', async () => {
  const referenz = makeSimplePdf(['EBENE-V Rechnung 4711']);
  const generiert = makeSimplePdf(['Rechnung 4711']);
  const target = await startMockTarget(() => ({ body: generiert }));
  const app = await startApp();

  try {
    const referenceId = await uploadReference(app.url, referenz);
    const anfrage = (ignoreWords) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        referenceId,
        ...(ignoreWords === undefined ? {} : { ignoreWords }),
      }),
    });

    const ohne = await (await fetch(`${app.url}/api/generate`, anfrage(undefined))).json();
    assert.equal(ohne.comparison.identical, false);
    assert.deepEqual(ohne.comparison.ignoredWords, { entries: [], count: 0 });

    const mit = await (await fetch(`${app.url}/api/generate`, anfrage('EBENE-V'))).json();
    assert.equal(mit.comparison.identical, true);
    assert.equal(mit.comparison.ignoredWords.count, 1);
  } finally {
    await app.close();
    await target.close();
  }
});

test('Ausschluss: Die Oberfläche bietet das Feld', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');
  const feld = html.match(/<input[^>]*id="ignore-words"[^>]*>/s)?.[0];

  assert.ok(feld, 'Eingabefeld für die Ausschlussliste fehlt');
  assert.match(feld, /type="text"/);
  assert.match(html, /Wörter vom Vergleich ausschließen/);

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /ignoreWords: dom\.ignoreWords\.value/, 'Die Einstellung wird nicht gesendet');
  assert.match(client, /saved\.ignoreWords/, 'Die Einstellung wird nicht gespeichert');
  assert.match(client, /comparison\.ignoredWords\?\.count/, 'Der Hinweis wird nicht angezeigt');
});
