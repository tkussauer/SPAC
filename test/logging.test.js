import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Logger, hexPreview } from '../src/server/lib/logger.js';
import { startApp, startMockTarget, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

async function tempLogger() {
  const dir = await mkdtemp(path.join(tmpdir(), 'spac-log-'));
  const file = path.join(dir, 'spac.log');
  return { file, log: new Logger({ file, toConsole: false }) };
}

/** Der gesendete Body muss bei einem Fehler vollständig im Log stehen. */
test('Log: Bei einem Fehler des Zielservice werden Body und Antwort protokolliert', async () => {
  const { file, log } = await tempLogger();
  const target = await startMockTarget(() => ({
    status: 415,
    contentType: 'text/plain',
    body: 'Unsupported Media Type: erwartet wird application/xml',
  }));
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
    assert.equal(response.status, 502);

    const logText = await readFile(file, 'utf8');

    // Gesendeter Body – vollständig, Zeile für Zeile
    assert.match(logText, /--- GESENDETER BODY \(\d+ Bytes, Kodierung utf8\) ---/);
    assert.ok(logText.includes('C:\\Vorlagen\\rechnung.tpl'), 'Vorlagepfad fehlt im Log');
    assert.ok(logText.includes('<rechnung nummer="4711">'), 'XML-Inhalt fehlt im Log');
    assert.ok(logText.includes('<position>Artikel B</position>'), 'Der Body wurde abgeschnitten');
    assert.ok(!logText.includes('<?xml'), 'Die XML-Deklaration gehört nicht in den Body');

    // Gesendete Header
    assert.match(logText, /Content-Type: text\/plain; charset=utf-8/);
    assert.match(logText, /Content-Length: \d+/);

    // Hexdump des Body-Anfangs
    assert.match(logText, /--- BODY-ANFANG ALS HEX ---/);
    assert.match(logText, /0000 {2}43 3a 5c 56/, 'Hexdump beginnt nicht mit "C:\\V"');

    // Antwort des Zielservice inklusive Fehlertext
    assert.match(logText, /--- ANTWORT: HTTP 415/);
    assert.ok(logText.includes('Unsupported Media Type: erwartet wird application/xml'));

    // Fehlerkennung
    assert.match(logText, /Fehlercode: TARGET_STATUS/);
  } finally {
    await app.close();
    await target.close();
  }
});

test('Log: Auch bei nicht erreichbarer URL wird der gesendete Body protokolliert', async () => {
  const { file, log } = await tempLogger();
  const app = await startApp({ log });

  try {
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

    const logText = await readFile(file, 'utf8');
    assert.match(logText, /Fehlercode: TARGET_UNREACHABLE/);
    assert.ok(logText.includes('C:\\Vorlagen\\rechnung.tpl'));
    assert.ok(logText.includes('<rechnung nummer="4711">'));
    assert.match(logText, /Keine Antwort erhalten/);
  } finally {
    await app.close();
  }
});

test('Log: Antwort, die kein PDF ist, landet im Klartext im Log', async () => {
  const { file, log } = await tempLogger();
  const target = await startMockTarget(() => ({
    contentType: 'text/html',
    body: '<html><body>Vorlage C:\\Vorlagen\\rechnung.tpl nicht gefunden</body></html>',
  }));
  const app = await startApp({ log });

  try {
    await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: target.url, templatePath: SAMPLE_TEMPLATE_PATH, xmlContent: SAMPLE_XML }),
    });

    const logText = await readFile(file, 'utf8');
    assert.match(logText, /Fehlercode: INVALID_PDF/);
    assert.ok(logText.includes('<html><body>Vorlage C:\\Vorlagen\\rechnung.tpl nicht gefunden</body></html>'));
  } finally {
    await app.close();
    await target.close();
  }
});

test('Log: Die Fehlerantwort an die Oberfläche enthält Body, Antwort und Logpfad', async () => {
  const { file, log } = await tempLogger();
  const target = await startMockTarget(() => ({ status: 400, contentType: 'text/plain', body: 'Feld fehlt' }));
  const app = await startApp({ log });

  try {
    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: target.url, templatePath: SAMPLE_TEMPLATE_PATH, xmlContent: SAMPLE_XML }),
    });
    const { error } = await response.json();

    assert.equal(error.code, 'TARGET_STATUS');
    assert.equal(error.logFile, file, 'Der Pfad zur Logdatei fehlt in der Fehlermeldung');
    assert.ok(error.details.request.body.includes('C:\\Vorlagen\\rechnung.tpl'));
    assert.ok(error.details.request.body.includes('<rechnung nummer="4711">'));
    assert.equal(error.details.request.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(error.details.response.status, 400);
    assert.equal(error.details.response.body, 'Feld fehlt');
  } finally {
    await app.close();
    await target.close();
  }
});

test('Log: Erfolgreiche Aufrufe werden knapp protokolliert, mit SPAC_LOG_BODY=1 vollständig', async () => {
  const target = await startMockTarget(() => ({ body: Buffer.from('%PDF-1.4\n%%EOF') }));

  const kurz = await tempLogger();
  const app = await startApp({ log: kurz.log });
  const ausfuehrlich = await tempLogger();
  const appMitBody = await startApp({ log: ausfuehrlich.log, logBodies: true });

  try {
    const payload = JSON.stringify({
      targetUrl: target.url,
      templatePath: SAMPLE_TEMPLATE_PATH,
      xmlContent: SAMPLE_XML,
    });
    const headers = { 'Content-Type': 'application/json' };

    await fetch(`${app.url}/api/generate`, { method: 'POST', headers, body: payload });
    await fetch(`${appMitBody.url}/api/generate`, { method: 'POST', headers, body: payload });

    const kurzText = await readFile(kurz.file, 'utf8');
    assert.match(kurzText, /HTTP 200, \d+ Bytes PDF in \d+ ms/);
    assert.ok(!kurzText.includes('<rechnung nummer="4711">'), 'Ohne SPAC_LOG_BODY kein Body im Log');

    const langText = await readFile(ausfuehrlich.file, 'utf8');
    assert.match(langText, /ERFOLG: POST/);
    assert.ok(langText.includes('<rechnung nummer="4711">'), 'Mit SPAC_LOG_BODY fehlt der Body');
  } finally {
    await app.close();
    await appMitBody.close();
    await target.close();
  }
});

test('Log: Sehr große Bodys werden gekürzt, damit die Logdatei handhabbar bleibt', async () => {
  const { file, log } = await tempLogger();
  log.logExchange({
    targetUrl: 'http://example.invalid/x',
    error: { code: 'TEST', message: 'Test' },
    request: { headers: {}, body: 'x'.repeat(150_000), bytes: 150_000, encoding: 'utf8' },
  });
  const logText = await readFile(file, 'utf8');
  assert.match(logText, /… \(gekürzt, insgesamt 150000 Zeichen\)/);
  assert.ok(logText.length < 130_000);
});

test('Log: Hexdump stellt Bytes und lesbare Zeichen dar', () => {
  const dump = hexPreview(Buffer.from('AB\nÄ', 'utf8'));
  assert.match(dump, /^0000 {2}41 42 0a c3 84/);
  assert.match(dump, /AB\.\.\./);
});
