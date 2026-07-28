import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPostBody, stripXmlDeclaration } from '../src/server/lib/buildPostBody.js';
import { makePdf, startApp, startMockTarget, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

/** FR2 – Der Button "Vergleich generieren" löst einen POST-Request an die eingegebene URL aus. */
test('FR2: "Vergleich generieren" sendet einen POST an die eingegebene Ziel-URL', async () => {
  const pdf = await makePdf([['Generiertes Dokument']]);
  const target = await startMockTarget(() => ({ body: pdf }));
  const app = await startApp();

  try {
    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: `${target.url}/generate`,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(target.requests.length, 1, 'Es wurde kein POST-Request abgesetzt');
    assert.equal(target.requests[0].method, 'POST');
    assert.equal(target.requests[0].url, '/generate');

    const result = await response.json();
    assert.equal(result.request.targetUrl, `${target.url}/generate`);
  } finally {
    await app.close();
    await target.close();
  }
});

test('FR2: Ungültige URLs werden vor dem Absenden abgefangen', async () => {
  const app = await startApp();
  try {
    for (const [targetUrl, expectedCode] of [
      ['', 'URL_REQUIRED'],
      ['kein-url-format', 'URL_INVALID'],
      ['ftp://server/datei', 'URL_PROTOCOL_UNSUPPORTED'],
    ]) {
      const response = await fetch(`${app.url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl, templatePath: SAMPLE_TEMPLATE_PATH, xmlContent: SAMPLE_XML }),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error.code, expectedCode);
    }
  } finally {
    await app.close();
  }
});

/**
 * FR3 – POST-Body:
 *   Zeile 1: Vorlagepfad
 *   Zeile 2: leer
 *   danach: XML-Inhalt ohne die XML-Deklaration
 */
test('FR3: buildPostBody erzeugt Vorlagepfad, Leerzeile und XML ohne Deklaration', () => {
  const body = buildPostBody({ templatePath: SAMPLE_TEMPLATE_PATH, xmlContent: SAMPLE_XML });
  const lines = body.split('\n');

  assert.equal(lines[0], SAMPLE_TEMPLATE_PATH, 'Zeile 1 muss der Vorlagepfad sein');
  assert.equal(lines[1], '', 'Zeile 2 muss leer sein');
  assert.equal(lines[2], '<rechnung nummer="4711">', 'Ab Zeile 3 folgt die XML ohne Deklaration');
  assert.ok(!body.includes('<?xml'), 'Die XML-Deklaration darf nicht im Body stehen');
  assert.ok(body.includes('<position>Artikel B</position>'));
});

test('FR3: CRLF wird normalisiert und XML ohne Deklaration bleibt unverändert', () => {
  const crlf = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<a>\r\n  <b/>\r\n</a>\r\n';
  assert.equal(stripXmlDeclaration(crlf), '<a>\n  <b/>\n</a>\n');

  const ohneDeklaration = '<a>\n  <b/>\n</a>\n';
  assert.equal(stripXmlDeclaration(ohneDeklaration), ohneDeklaration);
});

test('FR3: Der tatsächlich gesendete Body entspricht der Spezifikation', async () => {
  const pdf = await makePdf([['Generiertes Dokument']]);
  const target = await startMockTarget(() => ({ body: pdf }));
  const app = await startApp();

  try {
    await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
      }),
    });

    const received = target.requests[0];
    const lines = received.body.split('\n');
    assert.equal(lines[0], SAMPLE_TEMPLATE_PATH);
    assert.equal(lines[1], '');
    assert.equal(lines[2], '<rechnung nummer="4711">');
    assert.ok(!received.body.includes('<?xml'));
    // Dokumentierte Standardannahme zum offenen Klärungspunkt "Content-Type"
    assert.match(received.headers['content-type'], /^text\/plain/);
  } finally {
    await app.close();
    await target.close();
  }
});

test('FR3: Fehlende Pflichtangaben führen zu verständlichen Meldungen', () => {
  assert.throws(() => buildPostBody({ templatePath: '   ', xmlContent: SAMPLE_XML }), /Vorlagepfad/);
  assert.throws(() => buildPostBody({ templatePath: SAMPLE_TEMPLATE_PATH, xmlContent: '' }), /Test-XML/);
});
