import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPostBody, joinTemplateReference } from '../src/server/lib/buildPostBody.js';
import { startApp, startRawTarget, SAMPLE_XML } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readHtml() {
  return readFile(path.join(root, 'src/client/index.html'), 'utf8');
}

// ---------------------------------------------------------- (3) Pfad + Name verbinden

test('Vorlage: Pfad und Name werden mit „/" zur ersten Body-Zeile verbunden', () => {
  const body = buildPostBody({
    templatePath: 'C:\\Vorlagen',
    templateName: 'rechnung.tpl',
    xmlContent: '<r/>',
  });
  assert.equal(body.split('\n')[0], 'C:\\Vorlagen/rechnung.tpl');
});

test('Vorlage: joinTemplateReference verdoppelt vorhandene Trenner nicht', () => {
  assert.equal(joinTemplateReference('C:\\Vorlagen\\', 'rechnung.tpl'), 'C:\\Vorlagen/rechnung.tpl');
  assert.equal(joinTemplateReference('C:\\Vorlagen', '\\rechnung.tpl'), 'C:\\Vorlagen/rechnung.tpl');
  assert.equal(joinTemplateReference('pfad/', '/name'), 'pfad/name');
});

test('Vorlage: ohne Namen bleibt der Pfad unverändert (Abwärtskompatibilität)', () => {
  assert.equal(joinTemplateReference('C:\\Vorlagen\\rechnung.tpl', ''), 'C:\\Vorlagen\\rechnung.tpl');
  const body = buildPostBody({ templatePath: 'C:\\Vorlagen\\rechnung.tpl', xmlContent: '<r/>' });
  assert.equal(body.split('\n')[0], 'C:\\Vorlagen\\rechnung.tpl');
});

test('Vorlage: /api/generate sendet die verbundene Referenz an den Zielservice', async () => {
  const target = await startRawTarget();
  const app = await startApp();
  try {
    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: `${target.url}/generate`,
        templatePath: 'C:\\Vorlagen',
        templateName: 'rechnung.tpl',
        xmlContent: SAMPLE_XML,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(target.captured[0].body.split('\n')[0], 'C:\\Vorlagen/rechnung.tpl');
  } finally {
    await app.close();
    await target.close();
  }
});

// ------------------------------------------------------------ (1) Untertitel entfernt

test('Kopf: Der erklärende Untertitel wurde entfernt', async () => {
  const html = await readHtml();
  assert.doesNotMatch(html, /class="subtitle"/, 'Der Untertitel nimmt nur Platz weg und soll fehlen');
  assert.doesNotMatch(html, /Test-XML an den Zielservice senden/);
});

// ------------------------------------------------------ (2) Diagnose ein-/ausblendbar

test('Diagnose: Eingabefelder für Pfad und Namen sind getrennt vorhanden', async () => {
  const html = await readHtml();
  assert.match(html, /<input[^>]*id="template-path"[^>]*required/s, 'Vorlagepfad fehlt oder ist nicht Pflicht');
  assert.match(html, /<input[^>]*id="template-name"/s, 'Feld „Template-Name" fehlt');
});

test('Diagnose: Umschalter vorhanden, Werkzeuge standardmäßig ausgeblendet', async () => {
  const html = await readHtml();

  // Der Umschalter in den erweiterten Einstellungen ist standardmäßig NICHT angehakt.
  const toggle = html.match(/<input[^>]*id="show-diagnostics"[^>]*>/s)?.[0];
  assert.ok(toggle, 'Umschalter „Diagnose-Werkzeuge anzeigen" fehlt');
  assert.doesNotMatch(toggle, /checked/, 'Der Umschalter darf nicht vorausgewählt sein');

  // Beide Bereiche starten mit dem hidden-Attribut.
  assert.match(html, /<details id="capture"[^>]*\shidden/s, 'Postman-Vergleich ist nicht standardmäßig ausgeblendet');
  assert.match(html, /<details id="diagnostics"[^>]*\shidden/s, 'Diagnose ist nicht standardmäßig ausgeblendet');
});
