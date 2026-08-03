import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { verbindeTrennungen, extractPages } from '../src/server/lib/pdfText.js';
import {
  diffTokens,
  foldSegmentationDifferences,
  normalizeIgnoringHyphenation,
  similarity,
} from '../src/server/lib/diff.js';
import { segmentLine } from '../src/server/lib/markdownDiff.js';
import { makeSimplePdf } from './helpers/rawPdf.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Zwei Dokumente mit gleichem Inhalt brechen ihre Zeilen selten an derselben Stelle um. Aus
 * "nichtmilitärischen" wird dann einmal "nichtmi-" + "litärischen" und einmal "nicht-" +
 * "militärischen" – Wort für Wort verglichen wären das vier Abweichungen, obwohl der Text
 * derselbe ist.
 */
const wort = (text, y, x = 0, extra = {}) => ({
  text,
  box: { x, y, width: text.length * 5, height: 10 },
  ...extra,
});

test('Trennzeichen: Getrennte Wörter werden zusammengesetzt', () => {
  const ergebnis = verbindeTrennungen([
    wort('anderen', 100, 0),
    wort('nichtmi-', 100, 40),
    wort('litärischen', 112, 0),
    wort('Aufgaben', 112, 60),
  ]);

  assert.deepEqual(ergebnis.words.map((w) => w.text), ['anderen', 'nichtmilitärischen', 'Aufgaben']);
  assert.equal(ergebnis.joined, 1);
});

test('Trennzeichen: Unterschiedliche Trennstellen führen zum selben Text', () => {
  const links = verbindeTrennungen([wort('nichtmi-', 100), wort('litärischen', 112)]);
  const rechts = verbindeTrennungen([wort('nicht-', 100), wort('militärischen', 112)]);

  assert.deepEqual(links.words.map((w) => w.text), rechts.words.map((w) => w.text));
});

test('Trennzeichen: Echte Bindestriche bleiben unangetastet', () => {
  // Großgeschriebene Fortsetzung: Eigenname oder Abkürzung, keine Worttrennung.
  const eigenname = verbindeTrennungen([wort('E-', 100), wort('Mail', 112)]);
  assert.deepEqual(eigenname.words.map((w) => w.text), ['E-', 'Mail']);
  assert.equal(eigenname.joined, 0);

  // Vor dem Strich muss ein Buchstabe stehen – "- V" und "Ausbildungs-/" sind keine Trennung.
  assert.equal(verbindeTrennungen([wort('-', 100), wort('vertrag', 112)]).joined, 0);
  assert.equal(verbindeTrennungen([wort('Ausbildungs-/', 100), wort('hilfe', 112)]).joined, 0);
});

test('Trennzeichen: Über einen Absatzabstand hinweg wird nicht zusammengesetzt', () => {
  // Ein großer Abstand trennt Absätze oder Tabellenzeilen.
  const nah = verbindeTrennungen([wort('Betrags-', 100), wort('grenze', 112)]);
  assert.equal(nah.joined, 1);

  const fern = verbindeTrennungen([wort('Betrags-', 100), wort('grenze', 140)]);
  assert.equal(fern.joined, 0, 'Über die Lücke hinweg darf nichts verbunden werden');
});

test('Trennzeichen: Piktogramme werden nie angehängt', () => {
  const ergebnis = verbindeTrennungen([
    wort('Wahl-', 100),
    wort('a', 112, 0, { symbol: true }),
  ]);
  assert.equal(ergebnis.joined, 0);
});

test('Trennzeichen: Der Vergleich meldet keine Abweichung', async () => {
  const referenz = makeSimplePdf([
    'Werden Sie als Angehoeriger der Polizei an nichtmi-',
    'litaerischen Aufgaben im Ausland teilnehmen?',
  ]);
  const generiert = makeSimplePdf([
    'Werden Sie als Angehoeriger der Polizei an nicht-',
    'militaerischen Aufgaben im Ausland teilnehmen?',
  ]);

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, true, 'Der Text ist derselbe, nur anders getrennt');
  assert.deepEqual(ergebnis.pages[0].generated.highlights, []);
  assert.equal(ergebnis.hyphenation.count, 2, 'Je Dokument eine zusammengesetzte Trennung');
});

test('Trennzeichen: Echte Abweichungen bleiben sichtbar', async () => {
  const referenz = makeSimplePdf(['Betrag 100 EUR pro Kalender-', 'jahr fuer alle Leistungen']);
  const generiert = makeSimplePdf(['Betrag 999 EUR pro Kalen-', 'derjahr fuer alle Leistungen']);

  const ergebnis = await comparePdfs(referenz, generiert);

  assert.equal(ergebnis.identical, false, 'Die Betragsabweichung wurde verschluckt');
  const texte = ergebnis.pages[0].generated.highlights.map((h) => h.text);
  assert.ok(texte.includes('999'), `Erwartet 999 in ${JSON.stringify(texte)}`);
  assert.ok(!texte.some((t) => t.includes('jahr')), `Trennung wurde gemeldet: ${JSON.stringify(texte)}`);
});

test('Trennzeichen: Auch im extrahierten Text steht das ganze Wort', async () => {
  const { pages } = await extractPages(
    makeSimplePdf(['Angaben zur Kalender-', 'jahresmeldung des Betriebs'])
  );
  assert.ok(
    pages[0].words.some((w) => w.text === 'Kalenderjahresmeldung'),
    pages[0].words.map((w) => w.text).join(' ')
  );
});

test('Trennzeichen: Vergleichsform ohne Trennstriche', () => {
  assert.equal(normalizeIgnoringHyphenation('nichtmi- litärischen'), 'nichtmilitärischen');
  assert.equal(normalizeIgnoringHyphenation('nicht- militärischen'), 'nichtmilitärischen');
  assert.equal(normalizeIgnoringHyphenation('Kalender-jahr'), 'kalenderjahr');
});

test('Trennzeichen: Der Wortvergleich faltet reine Trennstrichunterschiede', () => {
  const a = ['an', 'nichtmi-', 'litärischen', 'Aufgaben'];
  const b = ['an', 'nicht-', 'militärischen', 'Aufgaben'];
  const ops = foldSegmentationDifferences(diffTokens(a, b), a, b);

  assert.ok(
    ops.some((op) => op.type === 'hyphenation'),
    `Kein Trennstrich-Ausgleich: ${JSON.stringify(ops.map((o) => o.type))}`
  );
  assert.ok(!ops.some((op) => op.type === 'removed' || op.type === 'added'), 'Es bleibt eine Abweichung');
  assert.equal(similarity(ops), 1, 'Solche Stellen zählen als übereinstimmend');
});

test('Trennzeichen: Im Markdown werden sie nicht hervorgehoben', () => {
  const { reference, generated } = segmentLine(
    'an nichtmi- litärischen Aufgaben',
    'an nicht- militärischen Aufgaben'
  );

  assert.ok(!reference.some((teil) => teil.changed), JSON.stringify(reference));
  assert.ok(!generated.some((teil) => teil.changed), JSON.stringify(generated));
});

test('Trennzeichen: Die Oberfläche weist die Zusammenführung aus', async () => {
  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /comparison\.hyphenation\?\.count/);
  assert.match(client, /am Zeilenende getrennte Wörter/);
});
