import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePdfs, mergeBoxes, projectBox, HIGHLIGHT_COLORS } from '../src/server/lib/comparePdfs.js';
import { makePdf } from './helpers/fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** FR6 – Abweichungen werden farblich hervorgehoben, ausschließlich im generierten Dokument. */
test('FR6: Markierungen erscheinen nur im generierten Dokument, nicht in der Referenz', async () => {
  const reference = await makePdf([['Rechnung 4711', 'Betrag 100 EUR']]);
  const generated = await makePdf([['Rechnung 4711', 'Betrag 999 EUR']]);

  const result = await comparePdfs(reference, generated);
  const page = result.pages[0];

  assert.equal(page.status, 'different');
  assert.deepEqual(page.reference.highlights, [], 'Die Referenz darf keine Markierungen erhalten');
  assert.ok(page.generated.highlights.length > 0, 'Keine Markierung im generierten PDF');

  for (const box of page.generated.highlights) {
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.equal(typeof box[key], 'number', `Box-Eigenschaft ${key} fehlt`);
      assert.ok(Number.isFinite(box[key]) && box[key] >= 0, `Box-Eigenschaft ${key} ist ungültig`);
    }
    // Boxen müssen innerhalb der Seite liegen, damit das Overlay passt
    assert.ok(box.x + box.width <= page.generated.width + 1);
    assert.ok(box.y + box.height <= page.generated.height + 1);
  }

  assert.ok(
    page.generated.highlights.some((box) => box.type === 'added' && box.text.includes('999')),
    'Der abweichende Text "999" wird im generierten PDF nicht markiert'
  );

  // Die Geometrie der Referenzseite bleibt für die Anzeige erhalten
  assert.ok(page.reference.width > 0 && page.reference.height > 0);

  // Rot als Markierungsfarbe (FR6)
  assert.equal(result.colors.added, HIGHLIGHT_COLORS.added);
  assert.match(result.colors.added, /^#e5484d$/i);
});

test('FR6: Fehlender Text wird im generierten Dokument an der Referenzposition markiert', async () => {
  // "Betrag 100 EUR" fehlt im generierten Dokument komplett.
  const reference = await makePdf([['Rechnung 4711', 'Betrag 100 EUR', 'Kunde Mustermann']]);
  const generated = await makePdf([['Rechnung 4711', 'Kunde Mustermann']]);

  const result = await comparePdfs(reference, generated);
  const page = result.pages[0];

  assert.deepEqual(page.reference.highlights, []);
  const fehlend = page.generated.highlights.filter((box) => box.type === 'missing');
  assert.ok(fehlend.length > 0, 'Fehlender Text wird nicht markiert');
  assert.ok(
    fehlend.some((box) => box.text.includes('Betrag') && box.text.includes('100')),
    `Der fehlende Text wird nicht benannt: ${JSON.stringify(fehlend)}`
  );

  // Die Markierung sitzt dort, wo der Text in der Referenz steht (zweite Zeile).
  const box = fehlend[0];
  assert.ok(box.y > 55 && box.y < 70, `Unerwartete Position der Markierung: y=${box.y}`);
  assert.ok(box.x >= 50 && box.x < 60, `Unerwartete Position der Markierung: x=${box.x}`);
  assert.equal(page.counts.removedWords, 3, 'Betrag, 100 und EUR fehlen');
  assert.equal(page.counts.addedWords, 0);
});

test('FR6: Positionen werden auf abweichende Seitenformate umgerechnet', () => {
  const box = { x: 100, y: 200, width: 50, height: 10 };
  const projiziert = projectBox(box, { width: 500, height: 1000 }, { width: 1000, height: 500 });
  assert.deepEqual(projiziert, { x: 200, y: 100, width: 100, height: 5 });

  // Gleiches Format -> unveränderte Box
  assert.deepEqual(projectBox(box, { width: 500, height: 1000 }, { width: 500, height: 1000 }), box);
});

test('FR6: Die Markierung liegt tatsächlich über dem abweichenden Wort', async () => {
  // "Betrag 100 EUR" in Helvetica 14pt ab x=50 (pdfkit-Standardrand):
  // "Betrag " ist 45,1pt breit, "100" 23,3pt breit -> Sollposition x ~ 95,1.
  const reference = await makePdf([['Betrag 100 EUR']]);
  const generated = await makePdf([['Betrag 999 EUR']]);
  const result = await comparePdfs(reference, generated);
  const box = result.pages[0].generated.highlights.find((entry) => entry.text === '999');

  assert.ok(box, 'Das abweichende Wort wurde nicht markiert');
  assert.ok(Math.abs(box.x - 95.1) < 3, `x-Position der Markierung ist ungenau: ${box.x}`);
  assert.ok(Math.abs(box.width - 23.3) < 3, `Breite der Markierung ist ungenau: ${box.width}`);
  // Die Markierung darf weder das vorherige noch das folgende Wort überdecken.
  assert.ok(box.x > 50 + 41, 'Die Markierung ragt in das Wort davor');
  assert.ok(box.x + box.width < 122 + 5, 'Die Markierung ragt in das Wort danach');
});

test('FR6: Identische Seiten erhalten keine Markierungen', async () => {
  const pdf = await makePdf([['Alles gleich hier']]);
  const result = await comparePdfs(pdf, pdf);
  assert.deepEqual(result.pages[0].reference.highlights, []);
  assert.deepEqual(result.pages[0].generated.highlights, []);
});

test('FR6: Benachbarte Wörter derselben Zeile werden zu einer Box zusammengefasst', () => {
  const merged = mergeBoxes([
    { x: 10, y: 20, width: 30, height: 12, text: 'Hallo' },
    { x: 42, y: 20, width: 25, height: 12, text: 'Welt' },
    { x: 10, y: 60, width: 20, height: 12, text: 'Zweite' },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, 'Hallo Welt');
  assert.equal(merged[0].x, 10);
  assert.equal(merged[0].width, 57);
  assert.equal(merged[1].text, 'Zweite');
});

test('FR6: Die UI enthält die rote Hervorhebung und rendert die Boxen', async () => {
  const css = await readFile(path.join(root, 'src/client/styles.css'), 'utf8');
  assert.match(css, /\.highlight\s*\{[^}]*background:\s*var\(--diff-soft\)/s, 'CSS-Regel .highlight fehlt');
  assert.match(css, /--diff:\s*#e5484d/i, 'Rote Markierungsfarbe fehlt');

  assert.match(css, /\.highlight\.missing\s*\{[^}]*border-style:\s*dashed/s, 'Stil für fehlenden Text fehlt');

  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /marker\.className\s*=\s*box\.type === 'missing'/, 'Die Boxen werden nicht als Overlay gerendert');
  assert.match(client, /highlights/, 'Die Hervorhebungen aus dem Vergleich werden nicht verwendet');
  // Prozentangaben statt fester Pixel: Die Markierungen müssen mitskalieren,
  // wenn das Canvas per CSS an die Spaltenbreite angepasst wird.
  assert.match(client, /marker\.style\.left\s*=\s*`\$\{\(box\.x \/ baseWidth\) \* 100\}%`/);
  assert.match(client, /marker\.style\.top\s*=\s*`\$\{\(box\.y \/ baseHeight\) \* 100\}%`/);

  // Die gebaute Anwendung enthält das Overlay ebenfalls
  const built = await readFile(path.join(root, 'public/app.js'), 'utf8');
  assert.ok(built.includes('highlight'), 'Im Build fehlt die Hervorhebungslogik');
});
