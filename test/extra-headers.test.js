import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile as read } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildCurlCommand, mergeHeaders, parseHeaderLines } from '../src/server/lib/httpHeaders.js';
import { Logger } from '../src/server/lib/logger.js';
import { startApp, startRawTarget, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function tempLogger() {
  const dir = await mkdtemp(path.join(tmpdir(), 'spac-hdr-'));
  const file = path.join(dir, 'spac.log');
  return { dir, file, log: new Logger({ file, toConsole: false }) };
}

test('Header: Zusätzliche Header werden aus der Texteingabe gelesen', () => {
  assert.deepEqual(parseHeaderLines('X-Api-Key: geheim\nAuthorization: Bearer 123'), {
    'X-Api-Key': 'geheim',
    Authorization: 'Bearer 123',
  });

  // Leerzeilen, Kommentare und Wagenrückläufe stören nicht
  assert.deepEqual(parseHeaderLines('\r\n# Kommentar\r\nX-Test:  Wert  \r\n\r\n'), { 'X-Test': 'Wert' });
  assert.deepEqual(parseHeaderLines(''), {});
  assert.deepEqual(parseHeaderLines(undefined), {});

  // Werte dürfen Doppelpunkte enthalten
  assert.deepEqual(parseHeaderLines('X-Url: http://server:8080/x'), { 'X-Url': 'http://server:8080/x' });
});

test('Header: Ungültige Eingaben werden verständlich abgelehnt', () => {
  assert.throws(() => parseHeaderLines('kein Doppelpunkt'), /Zeile 1 .* ungültig/);
  assert.throws(() => parseHeaderLines('Ungültiger Name: x'), /kein gültiger Header-Name/);
  assert.throws(() => parseHeaderLines('Content-Length: 5'), /automatisch gesetzt/);
  assert.throws(() => parseHeaderLines('host: example.org'), /automatisch gesetzt/);
});

test('Header: Zusatzheader ersetzen Standardheader unabhängig von der Schreibweise', () => {
  const standard = { 'Content-Type': 'text/plain', Accept: '*/*', 'User-Agent': 'SPAC/1.0' };

  assert.deepEqual(mergeHeaders(standard, { 'user-agent': 'PostmanRuntime/7.39.0' }), {
    'Content-Type': 'text/plain',
    Accept: '*/*',
    'user-agent': 'PostmanRuntime/7.39.0',
  });

  // Leerer Wert entfernt einen Standardheader
  assert.deepEqual(mergeHeaders(standard, { accept: '' }), {
    'Content-Type': 'text/plain',
    'User-Agent': 'SPAC/1.0',
  });

  assert.deepEqual(mergeHeaders(standard, {}), standard);
});

test('Header: Eigene Header gehen tatsächlich über die Leitung', async () => {
  const target = await startRawTarget();
  const app = await startApp();

  try {
    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        extraHeaders: 'X-Api-Key: geheim\nUser-Agent: PostmanRuntime/7.39.0\nAccept:',
      }),
    });
    assert.equal(response.status, 200);

    const headers = target.captured[0].headers;
    assert.equal(headers['x-api-key'], 'geheim');
    assert.equal(headers['user-agent'], 'PostmanRuntime/7.39.0');
    assert.equal(headers.accept, undefined, 'Ein leerer Wert muss den Standardheader entfernen');
    // Content-Length bleibt korrekt berechnet
    assert.equal(headers['content-length'], String(Buffer.byteLength(target.captured[0].body, 'utf8')));
  } finally {
    await app.close();
    await target.close();
  }
});

test('Header: Fehlerhafte Header-Eingaben erreichen den Zielservice gar nicht', async () => {
  const target = await startRawTarget();
  const app = await startApp();

  try {
    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        extraHeaders: 'völlig kaputt',
      }),
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'HEADER_INVALID');
    assert.equal(target.captured.length, 0, 'Es darf kein Request abgesetzt werden');
  } finally {
    await app.close();
    await target.close();
  }
});

test('cURL: Der Befehl bildet Ziel, Header und Body-Datei ab', () => {
  const befehl = buildCurlCommand({
    targetUrl: 'http://server:8080/generate',
    headers: { 'Content-Type': 'text/plain', 'Content-Length': '42', 'X-Api-Key': 'ge"heim' },
    bodyFile: 'C:\\logs\\last-request-body.txt',
  });

  assert.match(befehl, /^curl -X POST "http:\/\/server:8080\/generate"/);
  assert.match(befehl, /-H "Content-Type: text\/plain"/);
  assert.ok(!befehl.includes('Content-Length'), 'Content-Length setzt cURL selbst');
  assert.match(befehl, /-H "X-Api-Key: ge\\"heim"/, 'Anführungszeichen müssen maskiert werden');
  assert.match(befehl, /--data-binary "@C:\\logs\\last-request-body\.txt"/);
  assert.ok(!befehl.includes('\n'), 'Der Befehl muss einzeilig sein (cmd, PowerShell und Bash)');
});

test('cURL: Bei einem Fehler stehen Befehl und Body-Datei bereit', async () => {
  const { file, log } = await tempLogger();
  const target = await startRawTarget({ responseBody: Buffer.from('kein PDF') });
  const app = await startApp({ log });

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
    const { error } = await response.json();

    assert.equal(error.code, 'INVALID_PDF');
    assert.match(error.details.curl, /^curl -X POST "http:\/\/127\.0\.0\.1:\d+\/generate"/);
    assert.match(error.details.curl, /--data-binary "@/);
    assert.equal(error.details.request.curl, error.details.curl, 'Die Oberfläche erhält den Befehl mit');

    // Der Body liegt unverändert als Datei neben dem Log
    const abgelegt = await readFile(error.details.bodyFile, 'utf8');
    assert.equal(abgelegt, target.captured[0].body);
    assert.match(abgelegt, /^C:\\Vorlagen\\rechnung\.tpl\n\n<rechnung/);

    // ... und der Befehl steht auch im Log
    const logText = await readFile(file, 'utf8');
    assert.match(logText, /--- DERSELBE AUFRUF ALS CURL-BEFEHL ---/);
  } finally {
    await app.close();
    await target.close();
  }
});

test('Header: Die Oberfläche bietet ein Feld für zusätzliche Header', async () => {
  const html = await read(path.join(root, 'src/client/index.html'), 'utf8');
  assert.match(html, /<textarea[^>]*id="extra-headers"/s, 'Feld für zusätzliche Header fehlt');
  assert.match(html, /Name: Wert/, 'Hinweis zum Format fehlt');

  const client = await read(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /extraHeaders: dom\.extraHeaders\.value/, 'Die Header werden nicht mitgesendet');
  assert.match(client, /saved\.extraHeaders/, 'Die Header werden nicht gespeichert');
  assert.match(client, /request\.curl/, 'Der cURL-Befehl wird nicht angezeigt');
});
