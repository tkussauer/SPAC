import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, APP_VERSION_LABEL, APP_TITLE } from '../src/version.js';
import { startApp } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Die Version soll im Titel erscheinen. Maßgeblich ist package.json; der Anzeigetext „V3" wird
 * daraus abgeleitet. Diese Tests halten Titel, Überschrift und package.json zusammen – wird die
 * Version erhöht, ohne den Titel anzupassen (oder umgekehrt), schlagen sie an.
 */
test('Version: package.json liefert die Kennung V<Hauptversion>', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(APP_VERSION, pkg.version, 'APP_VERSION weicht von package.json ab');
  assert.equal(APP_VERSION_LABEL, `V${pkg.version.split('.')[0]}`);
  assert.equal(APP_VERSION_LABEL, 'V3', 'Aktuell erwartete Kennung ist V3');
  assert.equal(APP_TITLE, 'PDF-Vergleichstool V3');
});

test('Version: Browser-Titel und Überschrift zeigen die Kennung', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');

  assert.match(
    html,
    new RegExp(`<title>PDF-Vergleichstool ${APP_VERSION_LABEL}</title>`),
    'Der <title> enthält die Version nicht'
  );
  assert.match(
    html,
    new RegExp(`<h1>PDF-Vergleichstool\\s*<span[^>]*class="app-version"[^>]*>${APP_VERSION_LABEL}</span>`),
    'Die Überschrift zeigt die Version nicht'
  );
});

test('Version: /api/health meldet die Programmversion', async () => {
  const { url, close } = await startApp();
  try {
    const antwort = await fetch(`${url}/api/health`);
    const daten = await antwort.json();
    assert.equal(daten.app, APP_VERSION);
    assert.equal(daten.appLabel, APP_VERSION_LABEL);
  } finally {
    await close();
  }
});
