import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePdf, startApp, uploadReference } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Ob Eingabe- und Ankreuzfelder wirklich bedienbar sind, lässt sich nur im PDF-Betrachter
 * selbst prüfen. Die anderen Reiter zeichnen das Dokument nach – dort ist nichts anklickbar.
 * Der vierte Reiter bettet deshalb die unveränderte Datei ein.
 */
test('Original: Der vierte Reiter bettet das unveränderte PDF ein', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');

  assert.match(
    html,
    /id="tab-original"[^>]*aria-controls="original-panel"/s,
    'Reiter für die Originalansicht fehlt'
  );
  assert.match(html, /id="original-panel"[^>]*role="tabpanel"/s, 'Bereich fehlt');
  assert.match(html, /<iframe id="original-frame"/, 'Das PDF wird nicht eingebettet');
  assert.match(html, /id="original-which"/, 'Auswahl zwischen den beiden Dokumenten fehlt');
  assert.match(html, /id="original-open"[^>]*target="_blank"/s, 'Link in einen neuen Tab fehlt');
  assert.match(html, /id="original-fallback"[^>]*hidden/s, 'Rückfallhinweis fehlt');
});

test('Original: Der Reiter ist in die Umschaltung eingebunden', async () => {
  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');

  assert.match(client, /const TABS = \['pdf', 'markdown', 'style', 'original'\]/);
  assert.match(client, /dom\.originalPanel\.hidden = aktiv !== 'original'/);
  assert.match(client, /original: dom\.tabOriginal/, 'Der Reiter reagiert nicht auf Klicks');
  assert.match(client, /function applyOriginalDocument/);
  // Erst laden, wenn der Reiter offen ist – und nur bei geänderter Adresse, sonst gingen
  // Eingaben beim Reiterwechsel verloren.
  assert.match(client, /if \(force \|\| dom\.originalFrame\.getAttribute\('src'\) !== ziel\)/);
  assert.match(client, /navigator\.pdfViewerEnabled !== false/, 'Kein Rückfall ohne Betrachter');
});

test('Original: Das PDF wird zur Anzeige im Browser ausgeliefert', async () => {
  const app = await startApp();
  try {
    const pdf = await makePdf(['Rechnung 4711']);
    const id = await uploadReference(app.url, pdf);
    const antwort = await fetch(`${app.url}/api/pdf/${id}`);

    assert.equal(antwort.status, 200);
    assert.equal(antwort.headers.get('content-type'), 'application/pdf');
    assert.match(
      antwort.headers.get('content-disposition'),
      /^inline;/,
      'Zum Einbetten muss die Auslieferung "inline" sein, nicht "attachment"'
    );

    // Unverändert: Der Betrachter bekommt exakt die Bytes des Dokuments.
    const bytes = Buffer.from(await antwort.arrayBuffer());
    assert.deepEqual(bytes, pdf, 'Der Betrachter muss exakt die hochgeladenen Bytes bekommen');

    // Mit ?download=1 bleibt der Weg zum Speichern erhalten.
    const laden = await fetch(`${app.url}/api/pdf/${id}?download=1`);
    assert.match(laden.headers.get('content-disposition'), /^attachment;/);
  } finally {
    await app.close();
  }
});
