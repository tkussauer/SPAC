import test from 'node:test';
import assert from 'node:assert/strict';
import { postToTarget } from '../src/server/lib/postClient.js';
import { PdfStore } from '../src/server/lib/store.js';
import { makePdf, startApp, startMockTarget, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

/** NFR2 – Verständliche Fehlermeldungen für ungültige Datei, nicht erreichbare URL, fehlerhafte PDF-Response. */
test('NFR2: Nicht erreichbare URL liefert eine verständliche Meldung', async () => {
  const app = await startApp();
  try {
    // Port 1 ist auf keinem üblichen System belegt.
    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: 'http://127.0.0.1:1/generate',
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
      }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'TARGET_UNREACHABLE');
    assert.match(body.error.message, /nicht erreichbar/i);
  } finally {
    await app.close();
  }
});

test('NFR2: HTTP-Fehlerstatus des Zielservice wird weitergereicht', async () => {
  const target = await startMockTarget(() => ({
    status: 500,
    contentType: 'text/plain',
    body: 'Vorlage konnte nicht geladen werden',
  }));
  const app = await startApp();
  try {
    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: target.url, templatePath: SAMPLE_TEMPLATE_PATH, xmlContent: SAMPLE_XML }),
    });
    const body = await response.json();
    assert.equal(body.error.code, 'TARGET_STATUS');
    assert.match(body.error.message, /HTTP 500/);
    assert.match(body.error.message, /Vorlage konnte nicht geladen werden/);
  } finally {
    await app.close();
    await target.close();
  }
});

test('NFR2: Ungültige XML-Datei wird abgelehnt', async () => {
  const app = await startApp();
  try {
    // Eine leere Angabe heißt "ohne XML" und ist erlaubt; geprüft wird nur, was da ist.
    for (const [xmlContent, code] of [['Das ist nur Text ohne Markup', 'XML_INVALID']]) {
      const response = await fetch(`${app.url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: 'http://127.0.0.1:9/x',
          templatePath: SAMPLE_TEMPLATE_PATH,
          xmlContent,
          xmlFileName: 'test.xml',
        }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, code);
    }
  } finally {
    await app.close();
  }
});

test('NFR2: Ein beschädigtes Referenz-PDF führt zu einer klaren Meldung statt zum Absturz', async () => {
  const generated = await makePdf([['Alles gut']]);
  const target = await startMockTarget(() => ({ body: generated }));
  const app = await startApp();
  try {
    // PDF-Header korrekt, Inhalt kaputt -> Upload akzeptiert, Vergleich schlägt kontrolliert fehl.
    const upload = await fetch(`${app.url}/api/reference`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'kaputt.pdf' },
      body: Buffer.from('%PDF-1.4\nnur Müll ohne gültige Struktur'),
    });
    const { referenceId } = await upload.json();

    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        referenceId,
      }),
    });
    assert.equal(response.status, 200, 'Das generierte PDF muss trotzdem verfügbar bleiben');
    const result = await response.json();
    assert.equal(result.comparison, null);
    assert.ok(result.comparisonError, 'Es fehlt eine Fehlermeldung zum Vergleich');
    assert.match(result.comparisonError.message, /Referenz-PDF|gelesen|PDF/i);
  } finally {
    await app.close();
    await target.close();
  }
});

test('NFR2: Unbekannte Referenz-ID (z. B. nach Serverneustart) wird erklärt', async () => {
  const app = await startApp();
  try {
    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: 'http://127.0.0.1:9/x',
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        referenceId: 'gibt-es-nicht',
      }),
    });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).error.code, 'REFERENCE_NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('NFR2: Zeitüberschreitung wird gemeldet', async () => {
  const target = await startMockTarget(
    () => new Promise((resolve) => setTimeout(() => resolve({ body: Buffer.from('%PDF-1.4') }), 5000))
  );
  try {
    await assert.rejects(
      () => postToTarget({ targetUrl: target.url, body: 'x', timeoutMs: 150 }),
      (err) => {
        assert.equal(err.code, 'TARGET_TIMEOUT');
        assert.match(err.message, /Zeitüberschreitung/);
        return true;
      }
    );
  } finally {
    await target.close();
  }
});

test('Store: Alte Einträge werden verdrängt, damit der Speicher nicht wächst', () => {
  const store = new PdfStore({ maxEntries: 2 });
  const first = store.put(Buffer.from('a'));
  store.put(Buffer.from('b'));
  store.put(Buffer.from('c'));
  assert.equal(store.size, 2);
  assert.equal(store.get(first), null);
});

test('API: Unbekannte Endpunkte liefern eine saubere JSON-Fehlermeldung', async () => {
  const app = await startApp();
  try {
    const response = await fetch(`${app.url}/api/gibtsnicht`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  } finally {
    await app.close();
  }
});
