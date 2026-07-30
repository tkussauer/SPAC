import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { extractPages } from '../src/server/lib/pdfText.js';
import { makeVerticalMarginPdf, makeSimplePdf } from './helpers/rawPdf.mjs';
import { startApp, startMockTarget, uploadReference, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Seitliche Rahmenvermerke (Aktenzeichen, Stempel) sind meist um 90° gedreht. Solcher
 * vertikaler Text gehört nicht zum eigentlichen Inhalt und soll ausblendbar sein.
 */
test('Vertikal: Gedrehter Text wird als vertikal erkannt, waagerechter nicht', async () => {
  const { pages } = await extractPages(
    makeVerticalMarginPdf(['Waagerechte Zeile'], ['Aktenzeichen 2024'])
  );

  const vertikal = pages[0].words.filter((w) => w.vertical).map((w) => w.text);
  const horizontal = pages[0].words.filter((w) => !w.vertical).map((w) => w.text);

  assert.deepEqual(vertikal.sort(), ['2024', 'Aktenzeichen'], 'Der gedrehte Text muss vertikal sein');
  assert.ok(horizontal.includes('Waagerechte'), 'Waagerechter Text darf nicht vertikal sein');
});

test('Vertikal: Standardmäßig zählt vertikaler Text mit', async () => {
  const ref = makeVerticalMarginPdf(['Rechnung 4711'], ['Aktenzeichen 2024']);
  const gen = makeVerticalMarginPdf(['Rechnung 4711'], ['Aktenzeichen 2025']);

  const ergebnis = await comparePdfs(ref, gen);
  assert.equal(ergebnis.identical, false, 'Ohne Ausschluss muss der Randvermerk auffallen');
  assert.equal(ergebnis.verticalText.ignored, false);
  assert.ok(ergebnis.verticalText.count > 0);
});

test('Vertikal: Mit Ausschluss gelten die Dokumente als identisch', async () => {
  const ref = makeVerticalMarginPdf(['Rechnung 4711', 'Betrag 100 EUR'], ['Aktenzeichen 2024-XYZ']);
  const gen = makeVerticalMarginPdf(['Rechnung 4711', 'Betrag 100 EUR'], ['Aktenzeichen 2025-ABC']);

  const ergebnis = await comparePdfs(ref, gen, { ignoreVertical: true });

  assert.equal(ergebnis.identical, true, `Unerwartete Abweichung: ${JSON.stringify(ergebnis.pages[0].generated.highlights)}`);
  assert.deepEqual(ergebnis.pages[0].generated.highlights, []);
  assert.equal(ergebnis.markdown.identical, true, 'Auch der Markdown-Vergleich muss den vertikalen Text ausnehmen');
  assert.equal(ergebnis.verticalText.ignored, true);
  assert.ok(ergebnis.verticalText.count >= 2);
});

test('Vertikal: Waagerechter Inhalt wird weiterhin verglichen', async () => {
  const ref = makeVerticalMarginPdf(['Betrag 100 EUR'], ['Aktenzeichen 2024']);
  const gen = makeVerticalMarginPdf(['Betrag 999 EUR'], ['Aktenzeichen 2025']);

  const ergebnis = await comparePdfs(ref, gen, { ignoreVertical: true });

  assert.equal(ergebnis.identical, false, 'Die Abweichung im waagerechten Text wurde verschluckt');
  const markiert = ergebnis.pages[0].generated.highlights.filter((b) => b.type === 'added').map((b) => b.text);
  assert.deepEqual(markiert, ['999']);
  // Der vertikale Randvermerk darf nicht markiert sein
  assert.ok(!ergebnis.pages[0].generated.highlights.some((b) => b.text.includes('2025')));
});

test('Vertikal: Dokumente ohne vertikalen Text bleiben unberührt', async () => {
  const pdf = makeSimplePdf(['Nur waagerechter Text']);
  const ergebnis = await comparePdfs(pdf, pdf, { ignoreVertical: true });
  assert.equal(ergebnis.identical, true);
  assert.deepEqual(ergebnis.verticalText, { ignored: true, count: 0 });
});

test('Vertikal: Vertikaler Text verschmilzt nicht mit waagerechtem Nachbarn', async () => {
  // Der vertikale Text startet nahe dem waagerechten – beide dürfen nicht zu einem Wort werden.
  const { pages } = await extractPages(makeVerticalMarginPdf(['Kopf'], ['Rand']));
  const rand = pages[0].words.find((w) => w.text === 'Rand');
  const kopf = pages[0].words.find((w) => w.text === 'Kopf');
  assert.ok(rand?.vertical, 'Der Randvermerk muss vertikal sein');
  assert.ok(kopf && !kopf.vertical, 'Der Kopf muss waagerecht bleiben');
});

test('Vertikal: Die Einstellung wirkt über die API', async () => {
  const ref = makeVerticalMarginPdf(['Rechnung 4711'], ['Aktenzeichen 2024']);
  const gen = makeVerticalMarginPdf(['Rechnung 4711'], ['Aktenzeichen 2025']);
  const target = await startMockTarget(() => ({ body: gen }));
  const app = await startApp();

  try {
    const referenceId = await uploadReference(app.url, ref);
    const anfrage = (ignoreVertical) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        referenceId,
        ...(ignoreVertical === undefined ? {} : { ignoreVertical }),
      }),
    });

    const ohne = await (await fetch(`${app.url}/api/generate`, anfrage(undefined))).json();
    assert.equal(ohne.comparison.identical, false, 'Standardmäßig zählt der Randvermerk mit');
    assert.equal(ohne.comparison.verticalText.ignored, false);

    const mit = await (await fetch(`${app.url}/api/generate`, anfrage(true))).json();
    assert.equal(mit.comparison.identical, true);
    assert.equal(mit.comparison.verticalText.ignored, true);
  } finally {
    await app.close();
    await target.close();
  }
});

test('Vertikal: Die Oberfläche bietet den Schalter', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');
  const schalter = html.match(/<input[^>]*id="ignore-vertical"[^>]*>/s)?.[0];

  assert.ok(schalter, 'Schalter für vertikalen Text fehlt');
  assert.match(schalter, /type="checkbox"/);
  assert.ok(!/checked/.test(schalter), 'Vertikaler Text soll standardmäßig mitverglichen werden');
  assert.match(html, /Vertikalen Text .* ausschließen/);

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /ignoreVertical: dom\.ignoreVertical\.checked/, 'Die Einstellung wird nicht gesendet');
  assert.match(client, /saved\.ignoreVertical/, 'Die Einstellung wird nicht gespeichert');
  assert.match(client, /verticalText/, 'Der Hinweis wird nicht angezeigt');
});
