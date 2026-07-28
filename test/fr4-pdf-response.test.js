import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPages } from '../src/server/lib/pdfText.js';
import { makePdf, startApp, startMockTarget, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

/** FR4 – Die Response des POST-Aufrufs ist das PDF und wird in der Anwendung angezeigt/gespeichert. */
test('FR4: Das zurückgelieferte PDF wird gespeichert und kann abgerufen werden', async () => {
  const pdf = await makePdf([['Vergleichsdokument Seite 1'], ['Vergleichsdokument Seite 2']]);
  const target = await startMockTarget(() => ({ body: pdf, contentType: 'application/pdf' }));
  const app = await startApp();

  try {
    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: target.url, templatePath: SAMPLE_TEMPLATE_PATH, xmlContent: SAMPLE_XML }),
    });
    const result = await response.json();

    assert.ok(result.generatedId, 'Es wurde keine ID für das generierte PDF vergeben');
    assert.equal(result.generatedUrl, `/api/pdf/${result.generatedId}`);
    assert.equal(result.response.status, 200);
    assert.equal(result.response.bytes, pdf.length);

    // Das gespeicherte PDF ist byte-identisch abrufbar (Anzeige im Browser)
    const stored = await fetch(`${app.url}${result.generatedUrl}`);
    assert.equal(stored.status, 200);
    assert.equal(stored.headers.get('content-type'), 'application/pdf');
    assert.match(stored.headers.get('content-disposition'), /^inline/);
    const bytes = Buffer.from(await stored.arrayBuffer());
    assert.deepEqual(bytes, pdf);

    // ... und ist ein lesbares PDF mit zwei Seiten
    const parsed = await extractPages(bytes);
    assert.equal(parsed.pageCount, 2);
    assert.match(parsed.pages[0].text, /Vergleichsdokument Seite 1/);

    // Download-Variante
    const download = await fetch(`${app.url}${result.generatedUrl}?download=1`);
    assert.match(download.headers.get('content-disposition'), /^attachment/);
  } finally {
    await app.close();
    await target.close();
  }
});

test('FR4: Eine Antwort, die kein PDF ist, wird als Fehler gemeldet', async () => {
  const target = await startMockTarget(() => ({
    contentType: 'text/html',
    body: '<html><body>Interner Fehler in der Vorlage</body></html>',
  }));
  const app = await startApp();

  try {
    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: target.url, templatePath: SAMPLE_TEMPLATE_PATH, xmlContent: SAMPLE_XML }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'INVALID_PDF');
    assert.match(body.error.message, /kein gültiges PDF/i);
  } finally {
    await app.close();
    await target.close();
  }
});
