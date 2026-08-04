import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { extractPages } from '../src/server/lib/pdfText.js';
import { groupWordsIntoLines, pagesToMarkdown } from '../src/server/lib/pdfMarkdown.js';
import { buildLineDiff, segmentLine } from '../src/server/lib/markdownDiff.js';
import { makePdf, startApp, startMockTarget, uploadReference, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Wörter derselben Zeile müssen anhand ihrer Position wieder zusammenfinden. */
test('Markdown: Wörter werden zeilenweise gruppiert und von links nach rechts sortiert', () => {
  const lines = groupWordsIntoLines([
    { text: 'Welt', box: { x: 60, y: 20, width: 20, height: 12 } },
    { text: 'Hallo', box: { x: 10, y: 20.5, width: 30, height: 12 } },
    { text: 'Zweite', box: { x: 10, y: 60, width: 30, height: 12 } },
  ]);

  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'Hallo Welt');
  assert.equal(lines[1].text, 'Zweite');
});

test('Markdown: Ein PDF wird in eine lesbare Markdown-Fassung übersetzt', async () => {
  const pdf = await makePdf([['Rechnung 4711', 'Betrag 100 EUR'], ['Seite zwei']]);
  const { pages } = await extractPages(pdf);
  const { text, lines } = pagesToMarkdown(pages);

  assert.match(text, /^## Seite 1/, 'Seitenüberschrift fehlt');
  assert.ok(text.includes('## Seite 2'), 'Zweite Seite fehlt');
  assert.ok(text.includes('Rechnung 4711'));
  assert.ok(text.includes('Betrag 100 EUR'));
  assert.ok(text.includes('Seite zwei'));
  assert.deepEqual(lines.slice(0, 4), ['## Seite 1', '', 'Rechnung 4711', 'Betrag 100 EUR']);
});

test('Markdown: Zeilenvergleich erkennt geänderte, entfernte und ergänzte Zeilen', () => {
  const diff = buildLineDiff(
    ['Kopf', 'Betrag 100 EUR', 'Zahlbar bis 31.12.', 'Fuß'],
    ['Kopf', 'Betrag 999 EUR', 'Fuß', 'Neu hinzugekommen']
  );

  const typen = diff.rows.map((row) => row.type);
  assert.deepEqual(typen, ['equal', 'changed', 'removed', 'equal', 'added']);

  const geaendert = diff.rows[1];
  assert.equal(geaendert.reference, 'Betrag 100 EUR');
  assert.equal(geaendert.generated, 'Betrag 999 EUR');
  assert.equal(geaendert.referenceLine, 2);
  assert.equal(geaendert.generatedLine, 2);

  assert.equal(diff.rows[2].reference, 'Zahlbar bis 31.12.');
  assert.equal(diff.rows[2].generated, null);
  assert.equal(diff.rows[4].reference, null);
  assert.equal(diff.rows[4].generated, 'Neu hinzugekommen');

  assert.deepEqual(diff.totals, { equal: 2, changed: 1, removed: 1, added: 1, moved: 0 });
  assert.equal(diff.identical, false);
});

test('Markdown: Identische Texte ergeben einen leeren Unterschied', () => {
  const diff = buildLineDiff(['A', 'B'], ['A', 'B']);
  assert.equal(diff.identical, true);
  assert.deepEqual(
    diff.rows.map((row) => row.type),
    ['equal', 'equal']
  );
});

test('Markdown: Innerhalb geänderter Zeilen werden die abweichenden Wörter ausgezeichnet', () => {
  const { reference, generated } = segmentLine('Betrag 100 EUR netto', 'Betrag 999 EUR netto');

  assert.equal(reference.map((s) => s.text).join(''), 'Betrag 100 EUR netto');
  assert.equal(generated.map((s) => s.text).join(''), 'Betrag 999 EUR netto');
  assert.deepEqual(
    reference.filter((s) => s.changed).map((s) => s.text),
    ['100']
  );
  assert.deepEqual(
    generated.filter((s) => s.changed).map((s) => s.text),
    ['999']
  );
});

test('Markdown: Der Vergleich liefert die Markdown-Fassung beider Dokumente mit', async () => {
  const reference = await makePdf([['Rechnung 4711', 'Betrag 100 EUR', 'Zahlbar bis 31.12.']]);
  const generated = await makePdf([['Rechnung 4711', 'Betrag 999 EUR']]);

  const result = await comparePdfs(reference, generated);

  assert.ok(result.markdown, 'Die Markdown-Fassung fehlt im Ergebnis');
  assert.match(result.markdown.reference, /## Seite 1/);
  assert.ok(result.markdown.reference.includes('Betrag 100 EUR'));
  assert.ok(result.markdown.generated.includes('Betrag 999 EUR'));
  assert.equal(result.markdown.identical, false);

  const geaendert = result.markdown.rows.find((row) => row.type === 'changed');
  assert.ok(geaendert, 'Keine geänderte Zeile erkannt');
  assert.ok(geaendert.segments.generated.some((segment) => segment.changed && segment.text.includes('999')));

  const entfernt = result.markdown.rows.find((row) => row.type === 'removed');
  assert.equal(entfernt.reference, 'Zahlbar bis 31.12.');
});

test('Markdown: Identische PDFs melden auch textlich keinen Unterschied', async () => {
  const pdf = await makePdf([['Alles gleich hier']]);
  const result = await comparePdfs(pdf, pdf);
  assert.equal(result.markdown.identical, true);
  assert.equal(result.markdown.reference, result.markdown.generated);
});

test('Markdown: Der Vergleich steht über die API bereit', async () => {
  const reference = await makePdf([['Rechnung 4711', 'Betrag 100 EUR']]);
  const generated = await makePdf([['Rechnung 4711', 'Betrag 999 EUR']]);
  const target = await startMockTarget(() => ({ body: generated }));
  const app = await startApp();

  try {
    const referenceId = await uploadReference(app.url, reference);
    const response = await fetch(`${app.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        referenceId,
      }),
    });
    const result = await response.json();

    assert.ok(result.comparison.markdown, 'Die API liefert keinen Markdown-Vergleich');
    assert.ok(result.comparison.markdown.rows.length > 0);
    assert.ok(result.comparison.markdown.generated.includes('Betrag 999 EUR'));
  } finally {
    await app.close();
    await target.close();
  }
});

test('Markdown: Die Oberfläche stellt den Vergleich über einen Reiter bereit', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');

  assert.match(html, /role="tablist"/, 'Reiterleiste fehlt');
  assert.match(html, /id="tab-pdf"[^>]*aria-controls="viewer"/s, 'Reiter für die PDF-Ansicht fehlt');
  assert.match(html, /id="tab-markdown"[^>]*aria-controls="markdown-panel"/s, 'Reiter für den Markdown-Vergleich fehlt');
  assert.match(html, />\s*Markdown-Vergleich\s*</);
  assert.match(html, /id="markdown-panel"[^>]*role="tabpanel"/s, 'Bereich für den Markdown-Vergleich fehlt');
  assert.match(html, /id="toggle-only-diff"/, 'Filter "Nur Abweichungen" fehlt');

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /markdown: dom\.tabMarkdown/, 'Der Reiter ist nicht verdrahtet');
  assert.match(client, /button\.addEventListener\('click', \(\) => setActiveTab\(name\)\)/, 'Der Reiter schaltet die Ansicht nicht um');
  assert.match(client, /dom\.markdownPanel\.hidden = aktiv !== 'markdown'/, 'Die Ansicht wird nicht umgeschaltet');
  assert.match(client, /renderMarkdownDiff/, 'Der Markdown-Vergleich wird nicht gerendert');
  assert.match(client, /activeTab: state\.activeTab/, 'Der aktive Reiter wird nicht gespeichert');

  const built = await readFile(path.join(root, 'public/app.js'), 'utf8');
  assert.ok(built.includes('markdown-row'), 'Im Build fehlt die Markdown-Ansicht');
});
