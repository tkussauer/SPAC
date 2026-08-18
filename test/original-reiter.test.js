import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makePdf,
  startApp,
  startMockTarget,
  uploadReference,
  SAMPLE_XML,
  SAMPLE_TEMPLATE_PATH,
} from './helpers/fixtures.mjs';

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

/**
 * Ein Dokument soll sich auch **ohne Test-XML und ohne Referenz** erzeugen lassen – etwa um
 * zu prüfen, ob die Formularfelder einer Vorlage überhaupt bedienbar sind. Verglichen wird
 * dann nichts; es bleibt der Reiter „Original prüfen".
 */
test('Original: Erzeugen ohne XML und ohne Referenz', async () => {
  const generiert = await makePdf(['Nur aus der Vorlage']);
  let gesendeterBody = null;
  const target = await startMockTarget((anfrage) => {
    gesendeterBody = anfrage.body;
    return { body: generiert };
  });
  const app = await startApp();

  try {
    const antwort = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
      }),
    });
    const ergebnis = await antwort.json();

    assert.equal(antwort.status, 200);
    assert.equal(gesendeterBody, SAMPLE_TEMPLATE_PATH, 'Ohne XML wird nur der Vorlagepfad gesendet');
    assert.ok(ergebnis.generatedUrl, 'Das erzeugte PDF muss abrufbar sein');
    assert.equal(ergebnis.comparison, null, 'Ohne Referenz gibt es nichts zu vergleichen');
    assert.equal(ergebnis.referenceUrl ?? null, null);

    // Das Dokument liegt bereit und lässt sich im Betrachter öffnen.
    const pdf = await fetch(`${app.url}${ergebnis.generatedUrl}`);
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-disposition'), /^inline;/);
  } finally {
    await app.close();
    await target.close();
  }
});

test('Original: Ohne Referenz, aber mit XML – ebenfalls kein Vergleich', async () => {
  const generiert = await makePdf(['Aus der XML erzeugt']);
  let gesendeterBody = null;
  const target = await startMockTarget((anfrage) => {
    gesendeterBody = anfrage.body;
    return { body: generiert };
  });
  const app = await startApp();

  try {
    const antwort = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
      }),
    });
    const ergebnis = await antwort.json();

    assert.equal(antwort.status, 200);
    assert.ok(gesendeterBody.startsWith(`${SAMPLE_TEMPLATE_PATH}\n\n`), 'Mit XML bleibt der Aufbau gleich');
    assert.equal(ergebnis.comparison, null);
  } finally {
    await app.close();
    await target.close();
  }
});

test('Original: Ohne Vergleich bleibt allein der Original-Reiter', async () => {
  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');

  assert.match(client, /function verfuegbareReiter/, 'Die Reiterauswahl hängt nicht vom Ergebnis ab');
  assert.match(
    client,
    /return state\.markdown \? TABS : \['original'\]/,
    'Ohne Vergleichsergebnis müssen die drei Vergleichsreiter verschwinden'
  );
  assert.match(client, /knopf\.hidden = !verfuegbar\.includes\(name\)/, 'Die Reiter werden nicht ausgeblendet');

  // Test-XML und Referenz sind keine Pflichtfelder mehr.
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');
  const xml = html.match(/<input[^>]*id="xml-file"[^>]*>/s)?.[0];
  const referenz = html.match(/<input[^>]*id="reference-file"[^>]*>/s)?.[0];
  assert.ok(!/required/.test(xml), 'Die Test-XML darf keine Pflichtangabe mehr sein');
  assert.ok(!/required/.test(referenz), 'Das Referenz-PDF darf keine Pflichtangabe mehr sein');

  assert.match(client, /function canRefresh\(\)[\s\S]*?dom\.targetUrl/, 'Refresh hängt noch an der XML');
  assert.ok(
    !/showError\('Bitte zuerst eine Test-XML-Datei auswählen\.'\)/.test(client),
    'Der Zwang zur Test-XML ist noch da'
  );
});

test('Original: Ohne Referenz ist deren Auswahl gesperrt', async () => {
  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /referenzOption\.disabled = !state\.pdfUrls\.reference/);
  assert.match(
    client,
    /dom\.originalWhich\.value === 'reference' && !state\.pdfUrls\.reference/,
    'Eine gesperrte Auswahl muss auf das erzeugte PDF zurückfallen'
  );
});
