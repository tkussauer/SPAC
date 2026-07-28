import test from 'node:test';
import assert from 'node:assert/strict';
import { encodingFromContentType, postToTarget } from '../src/server/lib/postClient.js';
import { startApp, startRawTarget, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

/**
 * FR3 – Der POST-Body muss unverändert als Rohtext übertragen werden:
 * kein multipart/form-data, keine URL-Kodierung, kein Chunking, kein JSON-Wrapper.
 * Geprüft wird auf Byte-Ebene an einem rohen TCP-Server.
 */
test('FR3: Der Body geht 1:1 als Rohtext über die Leitung', async () => {
  const target = await startRawTarget();
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

    const wire = target.captured[0];
    const erwarteterBody =
      'C:\\Vorlagen\\rechnung.tpl\n' +
      '\n' +
      '<rechnung nummer="4711">\n' +
      '  <position>Artikel A</position>\n' +
      '  <position>Artikel B</position>\n' +
      '</rechnung>\n';

    assert.equal(wire.requestLine, 'POST /generate HTTP/1.1');
    // Exakte Bytes – kein Multipart-Rahmen, keine Kodierung, keine zusätzlichen Zeichen
    assert.equal(wire.body, erwarteterBody);
    assert.deepEqual(wire.bodyBytes, Buffer.from(erwarteterBody, 'utf8'));

    // Rohtext-Übertragung: feste Länge statt Chunking
    assert.equal(wire.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(wire.headers['content-length'], String(Buffer.byteLength(erwarteterBody, 'utf8')));
    assert.equal(wire.headers['transfer-encoding'], undefined, 'Der Body darf nicht chunked gesendet werden');
    assert.ok(!wire.body.includes('Content-Disposition'), 'Kein multipart/form-data');
    assert.ok(!wire.body.startsWith('{'), 'Kein JSON-Wrapper');
    assert.ok(!wire.body.includes('%3C'), 'Keine URL-Kodierung');
  } finally {
    await app.close();
    await target.close();
  }
});

test('FR3: Es werden nur die notwendigen Header gesendet (keine Browser-Header)', async () => {
  const target = await startRawTarget();
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

    const gesendet = Object.keys(target.captured[0].headers).sort();
    assert.deepEqual(gesendet, ['accept', 'connection', 'content-length', 'content-type', 'host']);
    for (const unerwuenscht of ['sec-fetch-mode', 'accept-language', 'accept-encoding', 'user-agent', 'origin']) {
      assert.equal(target.captured[0].headers[unerwuenscht], undefined, `Header ${unerwuenscht} darf nicht gesendet werden`);
    }
  } finally {
    await app.close();
    await target.close();
  }
});

test('FR3: Der Content-Type ist pro Aufruf einstellbar', async () => {
  const target = await startRawTarget();
  const app = await startApp();

  try {
    await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        contentType: 'application/xml',
      }),
    });

    assert.equal(target.captured[0].headers['content-type'], 'application/xml');
    // Der Body bleibt derselbe Rohtext – nur der Header ändert sich.
    assert.match(target.captured[0].body, /^C:\\Vorlagen\\rechnung\.tpl\n\n<rechnung/);
  } finally {
    await app.close();
    await target.close();
  }
});

test('FR3: Das charset im Content-Type bestimmt die Byte-Kodierung des Bodys', async () => {
  const target = await startRawTarget();
  try {
    await postToTarget({
      targetUrl: target.url,
      body: 'Vorlage\n\n<text>Grüße</text>',
      contentType: 'text/plain; charset=iso-8859-1',
    });

    const wire = target.captured[0];
    assert.deepEqual(wire.bodyBytes, Buffer.from('Vorlage\n\n<text>Grüße</text>', 'latin1'));
    // 27 Zeichen -> 27 Bytes: in latin1 belegt jeder Umlaut genau ein Byte
    // (in UTF-8 wären es 29 Bytes, da "ü" und "ß" dort je zwei Bytes brauchen).
    assert.equal(wire.headers['content-length'], '27');
    assert.equal(Buffer.byteLength('Vorlage\n\n<text>Grüße</text>', 'utf8'), 29);
  } finally {
    await target.close();
  }
});

test('FR3: UTF-8 ist der Standard und Umlaute werden korrekt kodiert', async () => {
  const target = await startRawTarget();
  try {
    await postToTarget({ targetUrl: target.url, body: '<text>Grüße</text>' });
    const wire = target.captured[0];
    assert.deepEqual(wire.bodyBytes, Buffer.from('<text>Grüße</text>', 'utf8'));
    assert.equal(wire.headers['content-length'], String(Buffer.byteLength('<text>Grüße</text>', 'utf8')));
  } finally {
    await target.close();
  }
});

test('FR3: charset-Erkennung deckt die üblichen Schreibweisen ab', () => {
  assert.equal(encodingFromContentType('text/plain'), 'utf8');
  assert.equal(encodingFromContentType('text/plain; charset=utf-8'), 'utf8');
  assert.equal(encodingFromContentType('text/plain;charset=UTF-8'), 'utf8');
  assert.equal(encodingFromContentType('text/plain; charset="ISO-8859-1"'), 'latin1');
  assert.equal(encodingFromContentType('application/xml; charset=windows-1252'), 'latin1');
  assert.equal(encodingFromContentType('text/plain; charset=us-ascii'), 'ascii');
  assert.equal(encodingFromContentType(undefined), 'utf8');
});

test('FR3: Die Oberfläche erlaubt das Einstellen des Content-Type', async () => {
  const app = await startApp();
  try {
    const html = await (await fetch(`${app.url}/`)).text();
    assert.ok(html.includes('id="content-type"'), 'Feld für den Content-Type fehlt');
    assert.ok(html.includes('value="text/plain; charset=utf-8"'), 'Standardwert fehlt');
  } finally {
    await app.close();
  }
});
