import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  parseTemplatePaths,
  readTemplatePaths,
  DEFAULT_TEMPLATE_PATHS,
  CONFIG_FILE,
} from '../src/server/lib/templatePaths.js';
import { createApp } from '../src/server/app.js';
import { startApp } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Vorlagepfade: Vorgaben enthalten die fünf VHV-Pfade, erster ist der Standard', () => {
  assert.deepEqual(DEFAULT_TEMPLATE_PATHS, [
    'icm://Interactive/VHV/Templates/KFZ',
    'icm://Interactive/VHV/Templates/KFZ/Hell',
    'icm://Interactive/VHV/Templates/Schaden KFZ',
    'icm://Interactive/VHV/Templates/Schaden KFZ/Hell',
    'icm://Interactive/VHV/Templates/Leben',
  ]);
  assert.equal(DEFAULT_TEMPLATE_PATHS[0], 'icm://Interactive/VHV/Templates/KFZ');
});

test('Vorlagepfade: Leerzeilen und Kommentare werden übersprungen, Reihenfolge bleibt', () => {
  const pfade = parseTemplatePaths('# Kommentar\n\nicm://A\n  icm://B mit Leerzeichen  \n\n# noch was\nicm://C\n');
  assert.deepEqual(pfade, ['icm://A', 'icm://B mit Leerzeichen', 'icm://C']);
});

test('Vorlagepfade: Datei im Wurzelverzeichnis wird gelesen; sonst gelten die Vorgaben', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'spac-tpl-'));
  try {
    await writeFile(path.join(dir, CONFIG_FILE), 'icm://Nur/Eins\nicm://Und/Zwei\n', 'utf8');
    assert.deepEqual(readTemplatePaths(dir), ['icm://Nur/Eins', 'icm://Und/Zwei']);

    // Ohne Datei: Vorgaben.
    const leer = await mkdtemp(path.join(os.tmpdir(), 'spac-tpl-leer-'));
    assert.deepEqual(readTemplatePaths(leer), DEFAULT_TEMPLATE_PATHS);
    await rm(leer, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Vorlagepfade: die mitgelieferte Konfigurationsdatei enthält die fünf Vorgaben', async () => {
  const inhalt = await readFile(path.join(root, CONFIG_FILE), 'utf8');
  assert.deepEqual(parseTemplatePaths(inhalt), DEFAULT_TEMPLATE_PATHS);
});

test('Vorlagepfade: /api/config liefert die Liste an die Oberfläche', async () => {
  const app = await startApp({ templatePaths: ['icm://X', 'icm://Y'] });
  try {
    const cfg = await (await fetch(`${app.url}/api/config`)).json();
    assert.deepEqual(cfg.templatePaths, ['icm://X', 'icm://Y']);
  } finally {
    await app.close();
  }
});

test('Vorlagepfade: ohne eigene Angabe liefert der Server die Vorgaben', async () => {
  // startApp reicht keine templatePaths durch -> createApp liest die Datei im Projekt.
  const app = await startApp();
  try {
    const cfg = await (await fetch(`${app.url}/api/config`)).json();
    assert.deepEqual(cfg.templatePaths, DEFAULT_TEMPLATE_PATHS);
  } finally {
    await app.close();
  }
});
