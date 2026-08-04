import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePdf, startApp, startMockTarget, uploadReference, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * FR7 – "Refresh" wiederholt den POST-Aufruf mit denselben Werten (URL, Vorlagepfad, Test-XML)
 * und aktualisiert Vergleichsergebnis und Hervorhebung.
 */
test('FR7: Refresh wiederholt den POST-Aufruf und aktualisiert das Ergebnis', async () => {
  const reference = await makePdf([['Rechnung 4711', 'Betrag 100 EUR']]);
  const abweichend = await makePdf([['Rechnung 4711', 'Betrag 999 EUR']]);

  // 1. Aufruf liefert ein abweichendes PDF, ab dem 2. Aufruf stimmt es mit der Referenz überein.
  const target = await startMockTarget((_req, callNumber) => ({
    body: callNumber === 1 ? abweichend : reference,
  }));
  const app = await startApp();

  try {
    const referenceId = await uploadReference(app.url, reference);
    const payload = {
      targetUrl: target.url,
      templatePath: SAMPLE_TEMPLATE_PATH,
      xmlContent: SAMPLE_XML,
      referenceId,
    };

    const first = await (
      await fetch(`${app.url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    ).json();

    assert.equal(first.comparison.identical, false);
    assert.deepEqual(first.comparison.differingPageNumbers, [1]);
    assert.ok(first.comparison.pages[0].generated.highlights.length > 0);

    // Refresh: identische Eingabewerte, erneuter POST
    const second = await (
      await fetch(`${app.url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    ).json();

    assert.equal(target.requests.length, 2, 'Der POST-Aufruf wurde nicht wiederholt');
    assert.deepEqual(target.requests[0].body, target.requests[1].body, 'Der Body muss identisch bleiben');
    assert.equal(target.requests[1].url, target.requests[0].url);

    // Ergebnis und Hervorhebung sind aktualisiert
    assert.notEqual(second.generatedId, first.generatedId, 'Es wurde kein neues PDF gespeichert');
    assert.equal(second.comparison.identical, true);
    assert.deepEqual(second.comparison.differingPageNumbers, []);
    assert.deepEqual(second.comparison.pages[0].generated.highlights, []);
    assert.equal(second.referenceId, referenceId, 'Die Referenz bleibt erhalten (NFR3)');
  } finally {
    await app.close();
    await target.close();
  }
});

test('FR7/NFR3: Die UI hat einen Refresh-Button und merkt sich URL und Vorlagepfad', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');
  assert.match(html, /id="refresh-button"/, 'Refresh-Button fehlt');
  assert.match(html, />\s*Refresh\s*</, 'Beschriftung "Refresh" fehlt');

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /refreshButton\.addEventListener\('click',\s*\(\)\s*=>\s*runComparison\(\{\s*reason:\s*'refresh'/);
  // NFR3: Werte werden gespeichert und beim Start wiederhergestellt
  assert.match(client, /localStorage\.setItem/);
  assert.match(client, /localStorage\.getItem/);
  assert.match(client, /loadSettings\(\)/);
});

/**
 * Beim Prüfen einer Vorlage wiederholt man den Durchlauf ständig. F6 löst ihn aus, damit die
 * Hand dafür nicht zur Maus muss.
 */
test('FR7: F6 löst den Refresh aus', async () => {
  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');

  const behandlung = client.match(/document\.addEventListener\('keydown',[\s\S]*?\}\);/)?.[0];
  assert.ok(behandlung, 'Es gibt keine Tastaturbehandlung');
  assert.match(behandlung, /event\.key !== 'F6'/, 'F6 wird nicht abgefragt');
  assert.match(behandlung, /event\.preventDefault\(\)/, 'Der Browser belegt F6 selbst – das muss unterdrückt werden');
  assert.match(behandlung, /dom\.refreshButton\.disabled/, 'Ein abgeblendeter Knopf darf nicht auslösen');
  assert.match(behandlung, /runComparison\(\{ reason: 'refresh' \}\)/, 'Es wird kein Refresh ausgelöst');
  // Mit Zusatztaste ist F6 ein anderes Kürzel und darf nicht greifen.
  assert.match(behandlung, /event\.ctrlKey \|\| event\.altKey/);

  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');
  const knopf = html.match(/<button[^>]*id="refresh-button"[\s\S]*?<\/button>/)?.[0];
  assert.match(knopf, /<kbd>F6<\/kbd>/, 'Das Kürzel steht nicht am Knopf');
  assert.match(knopf, /title="[^"]*F6[^"]*"/, 'Der Tooltip nennt das Kürzel nicht');
});
