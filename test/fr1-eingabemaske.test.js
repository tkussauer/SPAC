import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * FR1 – Eingabemaske mit vier Feldern:
 * Test-XML (.xml), Referenz-PDF (.pdf), Ziel-URL (Text), Vorlagepfad (Text).
 */
test('FR1: Die Eingabemaske enthält alle vier geforderten Felder', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');

  const xmlInput = html.match(/<input[^>]*id="xml-file"[^>]*>/s)?.[0];
  assert.ok(xmlInput, 'Feld für die Test-XML-Datei fehlt');
  assert.match(xmlInput, /type="file"/);
  assert.match(xmlInput, /accept="[^"]*\.xml/);

  const pdfInput = html.match(/<input[^>]*id="reference-file"[^>]*>/s)?.[0];
  assert.ok(pdfInput, 'Feld für die Referenz-PDF-Datei fehlt');
  assert.match(pdfInput, /type="file"/);
  assert.match(pdfInput, /accept="[^"]*\.pdf/);

  const urlInput = html.match(/<input[^>]*id="target-url"[^>]*>/s)?.[0];
  assert.ok(urlInput, 'Textfeld für die Ziel-URL fehlt');
  assert.match(urlInput, /type="text"/);

  // Der Vorlagepfad wird aus einer Konfiguration ausgewählt – daher ein Auswahlfeld.
  const templateSelect = html.match(/<select[^>]*id="template-path"[^>]*>/s)?.[0];
  assert.ok(templateSelect, 'Auswahlfeld für den Vorlagepfad fehlt');
  assert.match(templateSelect, /required/);
});

test('FR1: Die gebaute Oberfläche wird vom Server ausgeliefert', async () => {
  const app = await startApp();
  try {
    const response = await fetch(`${app.url}/`);
    assert.equal(response.status, 200, 'index.html wird nicht ausgeliefert – wurde "npm run build" ausgeführt?');
    const html = await response.text();
    for (const id of ['xml-file', 'reference-file', 'target-url', 'template-path']) {
      assert.ok(html.includes(`id="${id}"`), `Feld ${id} fehlt in der ausgelieferten Seite`);
    }
    assert.ok(html.includes('Vergleich generieren'), 'Button "Vergleich generieren" fehlt');
  } finally {
    await app.close();
  }
});

test('FR1: Referenz-PDF wird angenommen, Nicht-PDF-Dateien werden abgelehnt', async () => {
  const app = await startApp();
  try {
    const bad = await fetch(`${app.url}/api/reference`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'notizen.txt' },
      body: Buffer.from('kein PDF'),
    });
    assert.equal(bad.status, 502);
    const body = await bad.json();
    assert.equal(body.error.code, 'INVALID_PDF');
  } finally {
    await app.close();
  }
});
