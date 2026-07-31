import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { extractPages, liegtAusserhalb } from '../src/server/lib/pdfText.js';
import { alignStatesToItems, isInvisibleState } from '../src/server/lib/pdfStyle.js';
import { makeInvisibleTextPdf, makeSimplePdf } from './helpers/rawPdf.mjs';
import { startApp, startMockTarget, uploadReference, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * PDFs enthalten häufig Text, der gar nicht gezeichnet wird – etwa eine OCR-Textebene unter
 * einem Scan (Rendermodus 3), Text mit Deckkraft 0, Schriftgröße 0 oder Text außerhalb des
 * Seitenbereichs. Am Bildschirm ist davon nichts zu sehen; im Vergleich hat es nichts verloren.
 */
test('Unsichtbar: Nicht gezeichneter Text wird als solcher erkannt', async () => {
  const { pages } = await extractPages(
    makeInvisibleTextPdf(['Sichtbarer Text'], ['renderMode', 'alpha', 'nullGroesse'])
  );

  const nachText = Object.fromEntries(pages[0].words.map((w) => [w.text, Boolean(w.invisible)]));
  assert.equal(nachText.Sichtbarer, false, 'Sichtbarer Text darf nicht ausgeblendet werden');
  assert.equal(nachText.UnsichtbarerRenderModus, true, 'Rendermodus 3 wird nicht erkannt');
  assert.equal(nachText.UnsichtbareDeckkraft, true, 'Deckkraft 0 wird nicht erkannt');
  assert.equal(nachText.Nullgroesse, true, 'Schriftgröße 0 wird nicht erkannt');
});

test('Unsichtbar: Alle Varianten zusammen stören die Zuordnung nicht', async () => {
  // Text außerhalb der Seite steht in der Operatorliste, nicht aber im Textinhalt.
  // Die Zuordnung muss das überspringen können, statt ganz aufzugeben.
  const { pages } = await extractPages(
    makeInvisibleTextPdf(['Sichtbarer Text'], ['renderMode', 'alpha', 'nullGroesse', 'ausserhalb'])
  );

  const unsichtbare = pages[0].words.filter((w) => w.invisible).map((w) => w.text);
  assert.deepEqual(unsichtbare.sort(), [
    'Nullgroesse',
    'UnsichtbareDeckkraft',
    'UnsichtbarerRenderModus',
  ]);
  assert.ok(pages[0].words.some((w) => w.text === 'Sichtbarer' && !w.invisible));
  assert.ok(
    !pages[0].words.some((w) => w.text.includes('Ausserhalb')),
    'Text außerhalb der Seite darf gar nicht auftauchen'
  );
});

test('Unsichtbar: Solcher Text erzeugt keine Abweichung', async () => {
  const referenz = makeInvisibleTextPdf(['Rechnung 4711', 'Betrag 100 EUR'], ['renderMode', 'alpha']);
  const generiert = makeInvisibleTextPdf(['Rechnung 4711', 'Betrag 100 EUR'], []);

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, true, 'Der sichtbare Inhalt ist identisch');
  assert.deepEqual(ergebnis.pages[0].generated.highlights, []);
  assert.equal(ergebnis.markdown.identical, true);
  assert.equal(ergebnis.invisibleText.ignored, true);
  assert.equal(ergebnis.invisibleText.count, 2, 'Beide unsichtbaren Stellen werden gezählt');
});

test('Unsichtbar: Der Markdown-Text enthält die unsichtbaren Stellen nicht', async () => {
  const { markdown } = await comparePdfs(
    makeInvisibleTextPdf(['Rechnung 4711'], ['renderMode', 'alpha']),
    makeInvisibleTextPdf(['Rechnung 4711'], [])
  );

  assert.ok(!markdown.reference.includes('Unsichtbar'), `Unsichtbares im Markdown: ${markdown.reference}`);
  assert.equal(markdown.reference, markdown.generated);
});

test('Unsichtbar: Abschaltbar – dann wird der Text wieder verglichen', async () => {
  const referenz = makeInvisibleTextPdf(['Rechnung 4711'], ['renderMode', 'alpha']);
  const generiert = makeInvisibleTextPdf(['Rechnung 4711'], []);

  const ergebnis = await comparePdfs(referenz, generiert, { ignoreInvisible: false });

  assert.equal(ergebnis.identical, false);
  assert.equal(ergebnis.invisibleText.ignored, false);
  assert.equal(ergebnis.pages[0].counts.removedWords, 2);
});

test('Unsichtbar: Echte Abweichungen im sichtbaren Text bleiben sichtbar', async () => {
  const referenz = makeInvisibleTextPdf(['Betrag 100 EUR'], ['renderMode']);
  const generiert = makeInvisibleTextPdf(['Betrag 999 EUR'], []);

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, false, 'Die echte Abweichung wurde verschluckt');
  const markierungen = ergebnis.pages[0].generated.highlights;

  // "999" weicht ab, "100" fehlt gegenüber der Referenz – beides wird markiert.
  assert.deepEqual(
    markierungen.filter((box) => box.type === 'added').map((box) => box.text),
    ['999']
  );
  assert.deepEqual(
    markierungen.filter((box) => box.type === 'missing').map((box) => box.text),
    ['100']
  );
  // Der unsichtbare Text taucht in keiner Markierung auf
  assert.ok(
    !markierungen.some((box) => box.text.includes('Unsichtbar')),
    `Unsichtbarer Text wurde markiert: ${JSON.stringify(markierungen.map((b) => b.text))}`
  );
});

test('Unsichtbar: Dokumente ohne unsichtbare Inhalte bleiben unberührt', async () => {
  const pdf = makeSimplePdf(['Ganz normaler Text']);
  const ergebnis = await comparePdfs(pdf, pdf);
  assert.equal(ergebnis.identical, true);
  assert.deepEqual(ergebnis.invisibleText, { ignored: true, count: 0 });
});

test('Unsichtbar: Zustandsbewertung', () => {
  assert.equal(isInvisibleState({ renderMode: 3, alpha: 1 }), true, 'Modus 3 zeichnet nichts');
  assert.equal(isInvisibleState({ renderMode: 7, alpha: 1 }), true, 'Modus 7 dient nur dem Beschnitt');
  assert.equal(isInvisibleState({ renderMode: 0, alpha: 0 }), true, 'Deckkraft 0 ist unsichtbar');
  assert.equal(isInvisibleState({ renderMode: 0, alpha: 1 }), false);
  assert.equal(isInvisibleState({ renderMode: 2, alpha: 0.5 }), false, 'Halbtransparent bleibt sichtbar');
  assert.equal(isInvisibleState(null), false);
});

test('Unsichtbar: Text außerhalb des Seitenbereichs wird erkannt', () => {
  const seite = { width: 595, height: 842 };
  assert.equal(liegtAusserhalb({ x: 50, y: 50, width: 100, height: 12 }, seite), false);
  assert.equal(liegtAusserhalb({ x: -200, y: 50, width: 100, height: 12 }, seite), true, 'links daneben');
  assert.equal(liegtAusserhalb({ x: 50, y: -50, width: 100, height: 12 }, seite), true, 'oberhalb');
  assert.equal(liegtAusserhalb({ x: 700, y: 50, width: 100, height: 12 }, seite), true, 'rechts daneben');
  assert.equal(liegtAusserhalb({ x: 50, y: 900, width: 100, height: 12 }, seite), true, 'unterhalb');
  // Nur teilweise überstehender Text bleibt sichtbar
  assert.equal(liegtAusserhalb({ x: 560, y: 50, width: 100, height: 12 }, seite), false);
});

test('Unsichtbar: Zuordnung verweigert sich bei unpassendem Zeichenstrom', () => {
  const items = [{ str: 'Hallo' }, { str: 'Welt' }];
  const strom = [...'HalloWelt'].map((char) => ({ char, state: { renderMode: 0, alpha: 1 } }));

  assert.equal(alignStatesToItems(items, strom)?.length, 2, 'Passender Strom wird zugeordnet');
  // Zusätzliche Zeichen im Strom (z. B. Text außerhalb der Seite) werden übersprungen
  const mitZusatz = [
    ...[...'XYZ'].map((char) => ({ char, state: { renderMode: 3, alpha: 1 } })),
    ...strom,
  ];
  const zugeordnet = alignStatesToItems(items, mitZusatz);
  assert.equal(zugeordnet[0].state.renderMode, 0, 'Das Element muss den eigenen Zustand bekommen');

  // Fehlt ein Element im Strom, gibt es keine Zuordnung – statt zu raten
  assert.equal(alignStatesToItems([{ str: 'Fehlt' }], strom), null);
});

test('Unsichtbar: Die Einstellung wirkt über die API', async () => {
  const referenz = makeInvisibleTextPdf(['Rechnung 4711'], ['renderMode']);
  const generiert = makeInvisibleTextPdf(['Rechnung 4711'], []);
  const target = await startMockTarget(() => ({ body: generiert }));
  const app = await startApp();

  try {
    const referenceId = await uploadReference(app.url, referenz);
    const anfrage = (ignoreInvisible) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        referenceId,
        ...(ignoreInvisible === undefined ? {} : { ignoreInvisible }),
      }),
    });

    const standard = await (await fetch(`${app.url}/api/generate`, anfrage(undefined))).json();
    assert.equal(standard.comparison.identical, true, 'Standardmäßig wird Unsichtbares ignoriert');
    assert.equal(standard.comparison.invisibleText.ignored, true);

    const aus = await (await fetch(`${app.url}/api/generate`, anfrage(false))).json();
    assert.equal(aus.comparison.identical, false);
    assert.equal(aus.comparison.invisibleText.ignored, false);
  } finally {
    await app.close();
    await target.close();
  }
});

test('Unsichtbar: Die Oberfläche bietet den Schalter', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');
  const schalter = html.match(/<input[^>]*id="ignore-invisible"[^>]*>/s)?.[0];

  assert.ok(schalter, 'Schalter für unsichtbare Inhalte fehlt');
  assert.match(schalter, /type="checkbox"/);
  assert.match(schalter, /checked/, 'Unsichtbares soll standardmäßig ignoriert werden');
  assert.match(html, /Nicht sichtbare Inhalte ignorieren/);

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /ignoreInvisible: dom\.ignoreInvisible\.checked/, 'Die Einstellung wird nicht gesendet');
  assert.match(client, /saved\.ignoreInvisible/, 'Die Einstellung wird nicht gespeichert');
  assert.match(client, /invisibleText/, 'Der Hinweis wird nicht angezeigt');
});
