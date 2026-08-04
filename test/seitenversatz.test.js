import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { matchAcrossPages } from '../src/server/lib/pageShift.js';
import { buildLineDiff } from '../src/server/lib/markdownDiff.js';
import { makeMultiPagePdf } from './helpers/rawPdf.mjs';
import { startApp, startMockTarget, uploadReference, SAMPLE_XML, SAMPLE_TEMPLATE_PATH } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Verglichen wird Seite gegen Seite. Schiebt sich der Satz leicht, rutscht Text über die
 * Seitengrenze – und derselbe Inhalt wird zweimal gemeldet: auf der einen Seite als fehlend,
 * auf der nächsten als zusätzlich. Inhaltlich ist aber nichts anders.
 */
const REFERENZ = [
  ['Rechnung 4711', 'Betrag 100 EUR', 'Kunde Mustermann Berlin'],
  ['Zahlbar bis 31.12.2026', 'Vielen Dank'],
];
const VERSCHOBEN = [
  ['Rechnung 4711', 'Betrag 100 EUR'],
  ['Kunde Mustermann Berlin', 'Zahlbar bis 31.12.2026', 'Vielen Dank'],
];

test('Versatz: Text auf der Nachbarseite ist keine Abweichung', async () => {
  const ergebnis = await comparePdfs(makeMultiPagePdf(REFERENZ), makeMultiPagePdf(VERSCHOBEN));

  assert.equal(ergebnis.identical, true, 'Der Inhalt ist derselbe, nur anders umbrochen');
  assert.equal(ergebnis.totals.removedWords, 0);
  assert.equal(ergebnis.totals.addedWords, 0);
  assert.equal(ergebnis.pageShift.count, 6, 'Drei Wörter je Richtung');
  assert.deepEqual(ergebnis.pages[0].generated.highlights, []);
  assert.deepEqual(ergebnis.pages[1].generated.highlights, []);
});

test('Versatz: Der Markdown-Vergleich sagt dasselbe', async () => {
  const ergebnis = await comparePdfs(makeMultiPagePdf(REFERENZ), makeMultiPagePdf(VERSCHOBEN));

  assert.equal(ergebnis.markdown.identical, true, 'Beide Ansichten müssen übereinstimmen');
  assert.equal(ergebnis.markdown.totals.moved, 2, 'Die verschobene Zeile steht auf beiden Seiten');
  assert.equal(ergebnis.markdown.totals.removed, 0);
  assert.equal(ergebnis.markdown.totals.added, 0);

  const verschoben = ergebnis.markdown.rows.filter((row) => row.type === 'moved');
  assert.equal(verschoben.length, 2);
  assert.ok(
    verschoben.some((row) => (row.reference ?? row.generated).includes('Mustermann')),
    JSON.stringify(verschoben)
  );
});

test('Versatz: Abschaltbar – dann wird wieder gemeldet', async () => {
  const ergebnis = await comparePdfs(makeMultiPagePdf(REFERENZ), makeMultiPagePdf(VERSCHOBEN), {
    ignorePageShift: false,
  });

  assert.equal(ergebnis.identical, false);
  assert.equal(ergebnis.totals.removedWords, 3);
  assert.equal(ergebnis.totals.addedWords, 3);
  assert.equal(ergebnis.pageShift.count, 0);
  assert.equal(ergebnis.markdown.identical, false);
});

test('Versatz: Auch rückwärts – Text kommt eine Seite früher', async () => {
  const ergebnis = await comparePdfs(makeMultiPagePdf(VERSCHOBEN), makeMultiPagePdf(REFERENZ));

  assert.equal(ergebnis.identical, true);
  assert.equal(ergebnis.pageShift.count, 6);
});

test('Versatz: Über zwei Seiten hinweg bleibt es eine Abweichung', async () => {
  const weit = [
    ['Rechnung 4711', 'Betrag 100 EUR'],
    ['Zahlbar bis 31.12.2026', 'Vielen Dank'],
    ['Kunde Mustermann Berlin'],
  ];

  const ergebnis = await comparePdfs(makeMultiPagePdf(REFERENZ), makeMultiPagePdf(weit));
  assert.equal(ergebnis.identical, false, 'Zwei Seiten Versatz ist keine Verschiebung mehr');
  assert.equal(ergebnis.pageShift.count, 0);

  // Mit ausdrücklich größerer Toleranz greift es doch.
  const grosszuegig = await comparePdfs(makeMultiPagePdf(REFERENZ), makeMultiPagePdf(weit), {
    maxPageShift: 2,
  });
  assert.equal(grosszuegig.pageShift.count, 6);
});

test('Versatz: Echte Abweichungen bleiben erhalten', async () => {
  const geaendert = [
    ['Rechnung 4711', 'Betrag 999 EUR'],
    ['Kunde Mustermann Berlin', 'Zahlbar bis 31.12.2026', 'Vielen Dank'],
  ];

  const ergebnis = await comparePdfs(makeMultiPagePdf(REFERENZ), makeMultiPagePdf(geaendert));

  assert.equal(ergebnis.identical, false, 'Der geänderte Betrag muss auffallen');
  const texte = ergebnis.pages.flatMap((seite) => seite.generated?.highlights.map((h) => h.text) ?? []);
  assert.ok(texte.includes('999'), JSON.stringify(texte));
  assert.ok(
    !texte.some((text) => text.includes('Mustermann')),
    `Die Verschiebung wurde gemeldet: ${JSON.stringify(texte)}`
  );
});

test('Versatz: Eine ganze Seite später ist ebenfalls nur eine Verschiebung', async () => {
  // Das erzeugte Dokument beginnt mit einer zusätzlichen Deckseite; der Rest folgt eine
  // Seite später. Die Seitenzahl unterscheidet sich dann zwar, der Inhalt aber nicht.
  const mitDeckblatt = [['Deckblatt'], ...REFERENZ];
  const ergebnis = await comparePdfs(makeMultiPagePdf(REFERENZ), makeMultiPagePdf(mitDeckblatt));

  const gemeldet = ergebnis.pages.flatMap(
    (seite) => seite.generated?.highlights.map((h) => h.text) ?? []
  );
  assert.deepEqual(gemeldet, ['Deckblatt'], `Nur das Deckblatt ist neu: ${JSON.stringify(gemeldet)}`);
  assert.equal(ergebnis.pageCountMatches, false, 'Die Seitenzahl unterscheidet sich weiterhin');
});

test('Versatz: Zuordnung nur innerhalb des erlaubten Abstands', () => {
  const fehlend = [
    { pageIndex: 0, text: 'Kunde' },
    { pageIndex: 0, text: 'Weit' },
  ];
  const zusaetzlich = [
    { pageIndex: 1, text: 'Kunde' },
    { pageIndex: 5, text: 'Weit' },
  ];

  const ergebnis = matchAcrossPages(fehlend, zusaetzlich, 1);
  assert.deepEqual([...ergebnis.missing], [0], 'Nur die Nachbarseite zählt');
  assert.deepEqual([...ergebnis.added], [0]);
  assert.equal(ergebnis.count, 2);
});

test('Versatz: Ohne Kandidaten passiert nichts', () => {
  assert.equal(matchAcrossPages([], [{ pageIndex: 0, text: 'A' }], 1).count, 0);
  assert.equal(matchAcrossPages([{ pageIndex: 0, text: 'A' }], [], 1).count, 0);
  assert.equal(
    matchAcrossPages([{ pageIndex: 0, text: 'A' }], [{ pageIndex: 0, text: 'B' }], 1).count,
    0
  );
});

test('Versatz: Verschobene Zeilen im Zeilenvergleich', () => {
  const diff = buildLineDiff(
    ['## Seite 1', 'Kopf', 'Wandert', '## Seite 2', 'Fuß'],
    ['## Seite 1', 'Kopf', '## Seite 2', 'Wandert', 'Fuß']
  );

  assert.equal(diff.identical, true, 'Eine verschobene Zeile ist keine Abweichung');
  assert.equal(diff.totals.moved, 2);
  assert.ok(diff.rows.some((row) => row.type === 'moved' && row.reference === 'Wandert'));
});

test('Versatz: Eine Zeile, die weit springt, bleibt eine Abweichung', () => {
  const diff = buildLineDiff(
    ['## Seite 1', 'Wandert', '## Seite 2', 'A', '## Seite 3', 'B'],
    ['## Seite 1', 'A', '## Seite 2', 'B', '## Seite 3', 'Wandert']
  );

  assert.equal(diff.totals.moved, 0, 'Zwei Seiten Abstand ist keine Verschiebung');
  assert.equal(diff.identical, false);
});

test('Versatz: Die Einstellung wirkt über die API', async () => {
  const generiert = makeMultiPagePdf(VERSCHOBEN);
  const target = await startMockTarget(() => ({ body: generiert }));
  const app = await startApp();

  try {
    const referenceId = await uploadReference(app.url, makeMultiPagePdf(REFERENZ));
    const anfrage = (ignorePageShift) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: target.url,
        templatePath: SAMPLE_TEMPLATE_PATH,
        xmlContent: SAMPLE_XML,
        referenceId,
        ...(ignorePageShift === undefined ? {} : { ignorePageShift }),
      }),
    });

    const standard = await (await fetch(`${app.url}/api/generate`, anfrage(undefined))).json();
    assert.equal(standard.comparison.identical, true, 'Standardmäßig wird der Versatz toleriert');
    assert.equal(standard.comparison.pageShift.ignored, true);

    const aus = await (await fetch(`${app.url}/api/generate`, anfrage(false))).json();
    assert.equal(aus.comparison.identical, false);
    assert.equal(aus.comparison.pageShift.ignored, false);
  } finally {
    await app.close();
    await target.close();
  }
});

test('Versatz: Die Oberfläche bietet den Schalter', async () => {
  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');
  const schalter = html.match(/<input[^>]*id="ignore-page-shift"[^>]*>/s)?.[0];

  assert.ok(schalter, 'Schalter für den Seitenversatz fehlt');
  assert.match(schalter, /type="checkbox"/);
  assert.match(schalter, /checked/, 'Der Versatz soll standardmäßig toleriert werden');
  assert.match(html, /Nachbarseite nicht als Abweichung/);

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /ignorePageShift: dom\.ignorePageShift\.checked/);
  assert.match(client, /saved\.ignorePageShift/);
  assert.match(client, /comparison\.pageShift\?\.ignored/, 'Der Hinweis wird nicht angezeigt');
  assert.match(client, /moved: \{ reference: 'md-moved-bg'/, 'Verschobene Zeilen ohne Darstellung');
});
