import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseLineEndings, compareBodies, compareHeaders, compareRequests, firstDifference } from '../src/server/lib/requestDiff.js';
import { startApp, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Sendet eine Anfrage an den Aufzeichnungs-Endpunkt – bewusst über node:http,
 * damit ausschließlich die angegebenen Header ankommen (fetch ergänzt eigene).
 */
function zeichneAuf(appUrl, { headers = {}, body = '' } = {}) {
  const url = new URL(`${appUrl}/api/capture`);
  const payload = Buffer.from(body, 'utf8');

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Length': String(payload.length), ...headers },
      },
      (response) => {
        response.resume();
        response.on('end', () => {
          assert.equal(response.statusCode, 200);
          resolve();
        });
      }
    );
    request.on('error', reject);
    request.end(payload);
  });
}

/** Fragt den Vergleich mit den aktuellen Eingaben ab. */
async function vergleiche(appUrl, extra = {}) {
  const response = await fetch(`${appUrl}/api/capture/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templatePath: SAMPLE_TEMPLATE_PATH,
      xmlContent: SAMPLE_XML,
      ...extra,
    }),
  });
  return { status: response.status, daten: await response.json() };
}

test('Aufzeichnung: Eine Anfrage wird unverändert entgegengenommen', async () => {
  const app = await startApp();
  try {
    assert.deepEqual(await (await fetch(`${app.url}/api/capture`)).json(), { received: false });

    await zeichneAuf(app.url, {
      headers: { 'Content-Type': 'text/plain', 'X-Api-Key': 'geheim' },
      body: 'C:\\Vorlagen\\x.tpl\n\n<a/>',
    });

    const { received, request } = await (await fetch(`${app.url}/api/capture`)).json();
    assert.equal(received, true);
    assert.equal(request.method, 'POST');
    // Die ursprüngliche Schreibweise bleibt erhalten (Node liefert sonst nur Kleinbuchstaben).
    assert.equal(request.headers['X-Api-Key'], 'geheim');
    assert.equal(request.body, 'C:\\Vorlagen\\x.tpl\n\n<a/>');
    assert.equal(request.bytes, 23);

    // Verwerfen setzt zurück
    await fetch(`${app.url}/api/capture`, { method: 'DELETE' });
    assert.deepEqual(await (await fetch(`${app.url}/api/capture`)).json(), { received: false });
  } finally {
    await app.close();
  }
});

test('Aufzeichnung: Ohne Aufzeichnung erklärt der Vergleich, was zu tun ist', async () => {
  const app = await startApp();
  try {
    const { status, daten } = await vergleiche(app.url);
    assert.equal(status, 409);
    assert.equal(daten.error.code, 'NO_CAPTURE');
    assert.match(daten.error.message, /noch keine Anfrage aufgezeichnet/);
  } finally {
    await app.close();
  }
});

test('Aufzeichnung: Fehlender Header wird als Unterschied benannt und ist übernehmbar', async () => {
  const app = await startApp();
  try {
    // Postman-Aufruf mit identischem Body, aber zusätzlichem Schlüssel
    await zeichneAuf(app.url, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Api-Key': 'geheim' },
      body: `${SAMPLE_TEMPLATE_PATH}\n\n<rechnung nummer="4711">\n  <position>Artikel A</position>\n  <position>Artikel B</position>\n</rechnung>\n`,
    });

    const { status, daten } = await vergleiche(app.url);
    assert.equal(status, 200);

    const { comparison } = daten;
    assert.equal(comparison.body.identical, true, 'Der Body sollte identisch sein');
    assert.equal(comparison.identical, false, 'Der fehlende Header muss auffallen');

    const schluessel = comparison.headers.find((h) => h.key === 'x-api-key');
    assert.equal(schluessel.status, 'nur-aufgezeichnet');
    assert.equal(schluessel.captured, 'geheim');
    assert.equal(schluessel.adoptable, true);

    assert.ok(comparison.hints.some((h) => h.includes('X-Api-Key') && h.includes('fehlt')));
    assert.equal(comparison.suggestedHeaders, 'X-Api-Key: geheim');
  } finally {
    await app.close();
  }
});

test('Aufzeichnung: Abweichender Body wird auf Byte-Ebene lokalisiert', async () => {
  const app = await startApp();
  try {
    // Body mit CRLF und abweichendem Wert
    await zeichneAuf(app.url, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: `${SAMPLE_TEMPLATE_PATH}\r\n\r\n<rechnung nummer="9999">\r\n</rechnung>`,
    });

    const { daten } = await vergleiche(app.url);
    const body = daten.comparison.body;

    assert.equal(body.identical, false);
    assert.equal(body.lineEndings.application.art, 'LF');
    assert.equal(body.lineEndings.captured.art, 'CRLF');
    assert.equal(typeof body.firstDifferenceAt, 'number');
    assert.ok(body.applicationContext.hex.length > 0);
    assert.ok(daten.comparison.hints.some((h) => h.includes('Zeilenenden')));
    assert.ok(daten.comparison.hints.some((h) => h.includes('Erste Abweichung im Body')));
  } finally {
    await app.close();
  }
});

test('Aufzeichnung: Der Vergleich sendet nichts an den Zielservice', async () => {
  const app = await startApp();
  try {
    await zeichneAuf(app.url, { headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    // targetUrl wird bewusst nicht übergeben – der Vergleich darf sie nicht brauchen.
    const { status } = await vergleiche(app.url);
    assert.equal(status, 200);
  } finally {
    await app.close();
  }
});

test('Aufzeichnung: Automatisch gesetzte Header werden nicht als Problem gemeldet', () => {
  const headers = compareHeaders(
    { 'Content-Type': 'text/plain', 'Content-Length': '10', 'User-Agent': 'SPAC/1.0' },
    { 'content-type': 'text/plain', 'content-length': '12', host: '127.0.0.1', 'postman-token': 'abc' }
  );

  const contentLength = headers.find((h) => h.key === 'content-length');
  assert.equal(contentLength.status, 'unterschiedlich');
  assert.equal(contentLength.automatic, true);
  assert.equal(contentLength.adoptable, false, 'Content-Length darf nicht übernehmbar sein');

  const token = headers.find((h) => h.key === 'postman-token');
  assert.equal(token.toolSpecific, true);
  assert.equal(token.adoptable, false);

  const host = headers.find((h) => h.key === 'host');
  assert.equal(host.automatic, true);
});

test('Aufzeichnung: Body-Analyse erkennt BOM, Zeilenenden und Schlusszeilenumbruch', () => {
  const mitBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abc\r\n')]);
  const ohneBom = Buffer.from('abc\n');

  const ergebnis = compareBodies(ohneBom, mitBom);
  assert.equal(ergebnis.identical, false);
  assert.equal(ergebnis.bom.application, false);
  assert.equal(ergebnis.bom.captured, true);
  assert.equal(ergebnis.lineEndings.application.art, 'LF');
  assert.equal(ergebnis.lineEndings.captured.art, 'CRLF');
  assert.equal(ergebnis.trailingNewline.application, true);
  assert.equal(ergebnis.trailingNewline.captured, true);
  assert.equal(ergebnis.firstDifferenceAt, 0);

  assert.equal(compareBodies(ohneBom, ohneBom).identical, true);
  assert.equal(compareBodies(ohneBom, ohneBom).firstDifferenceAt, null);

  assert.deepEqual(analyseLineEndings(Buffer.from('a\nb\r\nc')), { art: 'gemischt', crlf: 1, lf: 1, cr: 0 });
  assert.equal(analyseLineEndings(Buffer.from('ohne')).art, 'keine');
  assert.equal(firstDifference(Buffer.from('abc'), Buffer.from('abd')), 2);
  assert.equal(firstDifference(Buffer.from('ab'), Buffer.from('abc')), 2);
});

test('Aufzeichnung: Identische Anfragen werden als identisch gemeldet', () => {
  const gleich = {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Content-Length': '3' },
    bodyBuffer: Buffer.from('abc'),
  };
  const ergebnis = compareRequests(gleich, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'content-length': '3', host: 'x' },
    bodyBuffer: Buffer.from('abc'),
  });

  assert.equal(ergebnis.identical, true);
  assert.deepEqual(ergebnis.hints, ['Kein Unterschied gefunden – beide Anfragen sind identisch.']);
  assert.equal(ergebnis.suggestedHeaders, '');
});

test('Aufzeichnung: Die Oberfläche führt durch den Vergleich', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');
  assert.match(html, /id="capture"/, 'Bereich für den Vergleich fehlt');
  assert.match(html, /id="capture-url"/, 'Die Aufzeichnungs-Adresse wird nicht angezeigt');
  assert.match(html, /id="capture-compare"/, 'Schaltfläche zum Vergleichen fehlt');
  assert.match(html, /id="capture-apply"/, 'Schaltfläche zum Übernehmen der Header fehlt');
  assert.match(html, /nichts an den Zielservice gesendet/, 'Hinweis zum Nebeneffekt fehlt');

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /\/api\/capture\/compare/, 'Der Vergleich wird nicht aufgerufen');
  assert.match(client, /uebernehmeCaptureHeader/, 'Die Header-Übernahme fehlt');
  assert.match(client, /window\.location\.origin.*\/api\/capture/, 'Die Adresse wird nicht aufgebaut');
});
