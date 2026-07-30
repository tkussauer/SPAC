import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePdfs, makeHeaderFooterPredicate, MM_TO_PT } from '../src/server/lib/comparePdfs.js';
import { makePositionedPdf, makeSimplePdf } from './helpers/rawPdf.mjs';
import { startApp, startMockTarget, uploadReference, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Referenz und generiert unterscheiden sich nur in Kopf- und Fußzeile (Datum, Seitenzahl). */
function seitenPaar() {
  const referenz = makePositionedPdf([
    { text: 'Erstellt am 01.01.2024', y: 812 },
    { text: 'Rechnung 4711 Betrag 100 EUR', y: 500 },
    { text: 'Seite 1 von 1', y: 20 },
  ]);
  const generiert = makePositionedPdf([
    { text: 'Erstellt am 31.12.2025', y: 812 },
    { text: 'Rechnung 4711 Betrag 100 EUR', y: 500 },
    { text: 'Seite 1', y: 20 },
  ]);
  return { referenz, generiert };
}

test('Kopf/Fuß: Standardmäßig werden Kopf- und Fußzeile mitverglichen', async () => {
  const { referenz, generiert } = seitenPaar();
  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, false, 'Ohne Ausschluss müssen die Randunterschiede auffallen');
  assert.equal(ergebnis.headerFooter.ignored, false);
});

test('Kopf/Fuß: Mit Ausschluss gelten die Dokumente als identisch', async () => {
  const { referenz, generiert } = seitenPaar();
  const ergebnis = await comparePdfs(referenz, generiert, { ignoreHeaderFooter: true });

  assert.equal(ergebnis.identical, true, `Unerwartete Abweichung: ${JSON.stringify(ergebnis.pages[0].generated.highlights)}`);
  assert.deepEqual(ergebnis.pages[0].generated.highlights, []);
  assert.equal(ergebnis.markdown.identical, true, 'Auch der Markdown-Vergleich muss die Randbereiche ausnehmen');
  assert.equal(ergebnis.headerFooter.ignored, true);
  // Kopf (2 Zeilen) und Fuß (2 bzw. 1 Zeile) beider Dokumente werden gezählt
  assert.ok(ergebnis.headerFooter.count > 0);
});

test('Kopf/Fuß: Der Körper wird weiterhin verglichen', async () => {
  const referenz = makePositionedPdf([
    { text: 'Datum 01.01.2024', y: 812 },
    { text: 'Betrag 100 EUR', y: 500 },
  ]);
  const generiert = makePositionedPdf([
    { text: 'Datum 31.12.2025', y: 812 },
    { text: 'Betrag 999 EUR', y: 500 },
  ]);

  const ergebnis = await comparePdfs(referenz, generiert, { ignoreHeaderFooter: true });

  assert.equal(ergebnis.identical, false, 'Die Abweichung im Körper wurde verschluckt');
  const markiert = ergebnis.pages[0].generated.highlights.filter((b) => b.type === 'added').map((b) => b.text);
  assert.deepEqual(markiert, ['999']);
  // Das Datum im Kopf darf nicht markiert sein
  assert.ok(!ergebnis.pages[0].generated.highlights.some((b) => b.text.includes('31.12')));
});

test('Kopf/Fuß: Nur Kopf oder nur Fuß ausschließbar (Höhe 0)', async () => {
  // Einzelne, unterscheidbare Tokens – markiert wird jeweils nur das abweichende Wort.
  const referenz = makePositionedPdf([
    { text: 'HeaderEins', y: 812 },
    { text: 'Koerper', y: 500 },
    { text: 'FooterEins', y: 20 },
  ]);
  const generiert = makePositionedPdf([
    { text: 'HeaderZwei', y: 812 },
    { text: 'Koerper', y: 500 },
    { text: 'FooterZwei', y: 20 },
  ]);

  // Nur Fußzeile ausschließen (Kopf 0 mm) -> Kopf fällt weiterhin auf, Fuß nicht mehr.
  const nurFuss = await comparePdfs(referenz, generiert, { ignoreHeaderFooter: true, headerMm: 0, footerMm: 25 });
  const markiertFuss = nurFuss.pages[0].generated.highlights.map((b) => b.text).join(' ');
  assert.ok(markiertFuss.includes('Header'), 'Der Kopf muss weiterhin verglichen werden');
  assert.ok(!markiertFuss.includes('Footer'), 'Die Fußzeile darf nicht mehr auffallen');

  // Nur Kopfzeile ausschließen (Fuß 0 mm) -> Fuß fällt weiterhin auf, Kopf nicht mehr.
  const nurKopf = await comparePdfs(referenz, generiert, { ignoreHeaderFooter: true, headerMm: 25, footerMm: 0 });
  const markiertKopf = nurKopf.pages[0].generated.highlights.map((b) => b.text).join(' ');
  assert.ok(markiertKopf.includes('Footer'), 'Der Fuß muss weiterhin verglichen werden');
  assert.ok(!markiertKopf.includes('Header'), 'Die Kopfzeile darf nicht mehr auffallen');
});

test('Kopf/Fuß: Das Prädikat rechnet mm korrekt in Punkte um', () => {
  const seite = { height: 842 };
  const pred = makeHeaderFooterPredicate(25, 25);
  const grenze = 25 * MM_TO_PT; // ~70.9 pt

  // Wort mit Mitte knapp innerhalb des Kopfbereichs
  assert.equal(pred({ box: { y: grenze - 10, height: 4 } }, seite), true, 'im Kopfbereich');
  // Wort klar im Körper
  assert.equal(pred({ box: { y: 400, height: 12 } }, seite), false, 'im Körper');
  // Wort im Fußbereich
  assert.equal(pred({ box: { y: 842 - grenze + 5, height: 12 } }, seite), true, 'im Fußbereich');

  // Höhe 0 schaltet den jeweiligen Bereich ab
  const ohneKopf = makeHeaderFooterPredicate(0, 25);
  assert.equal(ohneKopf({ box: { y: 5, height: 4 } }, seite), false, 'Kopf 0 mm schließt nichts oben aus');
});

test('Kopf/Fuß: Dokumente ohne Randinhalte bleiben unberührt', async () => {
  const pdf = makeSimplePdf(['Nur Fließtext hier']);
  const ergebnis = await comparePdfs(pdf, pdf, { ignoreHeaderFooter: true });
  assert.equal(ergebnis.identical, true);
});

test('Kopf/Fuß: Die Einstellung wirkt über die API', async () => {
  const { referenz, generiert } = seitenPaar();
  const target = await startMockTarget(() => ({ body: generiert }));
  const app = await startApp();

  try {
    const referenceId = await uploadReference(app.url, referenz);
    const anfrage = (extra) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        referenceId,
        ...extra,
      }),
    });

    const ohne = await (await fetch(`${app.url}/api/generate`, anfrage({}))).json();
    assert.equal(ohne.comparison.identical, false, 'Ohne Ausschluss fallen die Ränder auf');

    const mit = await (
      await fetch(`${app.url}/api/generate`, anfrage({ ignoreHeaderFooter: true, headerMm: 25, footerMm: 25 }))
    ).json();
    assert.equal(mit.comparison.identical, true, 'Mit Ausschluss sind die Dokumente identisch');
    assert.equal(mit.comparison.headerFooter.ignored, true);
    assert.equal(mit.comparison.headerFooter.headerMm, 25);
  } finally {
    await app.close();
    await target.close();
  }
});

test('Oberfläche: Ziel-URL steht in den Einstellungen mit dem Vorgabewert', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');

  const details = html.match(/<details class="advanced"[\s\S]*?<\/details>/)?.[0] ?? '';
  assert.ok(details.includes('id="target-url"'), 'Die Ziel-URL muss in den Einstellungen liegen');
  assert.match(
    details,
    /id="target-url"[^>]*value="https:\/\/inspire-scaler\.ccm\.dev\.babiel\.com\/rest\/api\/submit-job\/CreateTestDocumentDl"/s,
    'Der Vorgabewert der Ziel-URL fehlt'
  );

  // Nicht mehr im Hauptraster (nur die drei übrigen Felder)
  const grid = html.match(/<div class="grid">[\s\S]*?<\/div>\s*<details/)?.[0] ?? '';
  assert.ok(!grid.includes('id="target-url"'), 'Die Ziel-URL darf nicht mehr im Hauptraster stehen');
});

test('Oberfläche: Schalter und Felder für Kopf-/Fußzeile sind vorhanden', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');
  assert.match(html, /id="ignore-header-footer"/, 'Schalter für Kopf-/Fußzeile fehlt');
  assert.match(html, /Kopf- und Fußzeile ausschließen/);
  assert.match(html, /id="header-mm"/, 'Feld für die Kopfzeilenhöhe fehlt');
  assert.match(html, /id="footer-mm"/, 'Feld für die Fußzeilenhöhe fehlt');

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /ignoreHeaderFooter: dom\.ignoreHeaderFooter\.checked/, 'Die Einstellung wird nicht gesendet');
  assert.match(client, /headerMm: Number\(dom\.headerMm\.value\)/, 'Die Kopfzeilenhöhe wird nicht gesendet');
  assert.match(client, /saved\.ignoreHeaderFooter/, 'Die Einstellung wird nicht gespeichert');
});
