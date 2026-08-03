import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { comparePdfs } from '../src/server/lib/comparePdfs.js';
import { extractPages } from '../src/server/lib/pdfText.js';
import { findXfaStreams, parseXfaFieldValues, xfaLookupName, xfaFieldValues } from '../src/server/lib/xfa.js';
import { makeFormFieldPdf, makeSimplePdf } from './helpers/rawPdf.mjs';

/**
 * Hybrid-Formulare: Die AcroForm-Felder sind leer, es gibt keine Erscheinungsströme – der Wert
 * steht ausschließlich im XFA-Template. Erst der Acrobat Reader baut daraus die sichtbare Seite
 * auf; jeder andere Betrachter zeigt an dieser Stelle nichts. So erzeugt es z. B. Quadient
 * Inspire.
 */
const FELDER = [
  { label: 'Name', value: 'Max Mustermann', y: 780 },
  { label: 'Betrag', value: '4711 EUR', y: 750 },
];

test('XFA: Werte aus dem Template landen im Vergleich', async () => {
  const { pages } = await extractPages(makeFormFieldPdf(FELDER, ['nurXfa']));

  assert.deepEqual(
    pages[0].words.filter((w) => w.formField).map((w) => w.text),
    ['Max', 'Mustermann', '4711', 'EUR'],
    'Die Werte stehen nur im XFA-Teil und müssen von dort kommen'
  );
});

test('XFA: Abweichende Werte werden gemeldet und markiert', async () => {
  const generiert = makeFormFieldPdf(
    [
      { label: 'Name', value: 'Erika Musterfrau', y: 780 },
      { label: 'Betrag', value: '4711 EUR', y: 750 },
    ],
    ['nurXfa']
  );

  const ergebnis = await comparePdfs(makeFormFieldPdf(FELDER, ['nurXfa']), generiert);

  assert.equal(ergebnis.identical, false);
  assert.equal(ergebnis.markdown.identical, false);
  assert.deepEqual(
    ergebnis.pages[0].generated.highlights.filter((b) => b.type === 'added').map((b) => b.text),
    ['Erika Musterfrau']
  );
  assert.equal(ergebnis.formFields.count, 8);
});

test('XFA: Gleiche Werte erzeugen keine Abweichung', async () => {
  const ergebnis = await comparePdfs(
    makeFormFieldPdf(FELDER, ['nurXfa']),
    makeFormFieldPdf(FELDER, ['nurXfa'])
  );
  assert.equal(ergebnis.identical, true);
});

test('XFA: Datenströme werden gefunden – gepackt wie ungepackt', () => {
  const xml = '<?xml version="1.0"?><xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>';
  const bau = (inhalt) =>
    Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /AcroForm << /XFA 2 0 R >> >>\nendobj\n2 0 obj\n<< >>\nstream\n', 'latin1'),
      inhalt,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]);

  assert.deepEqual(findXfaStreams(bau(Buffer.from(xml, 'utf8'))), [xml]);
  assert.deepEqual(findXfaStreams(bau(zlib.deflateSync(Buffer.from(xml, 'utf8')))), [xml]);
});

test('XFA: Ohne /XFA-Eintrag wird gar nicht erst gesucht', () => {
  assert.deepEqual(findXfaStreams(makeSimplePdf(['Ganz normaler Text'])), []);
  assert.equal(xfaFieldValues(makeSimplePdf(['Text'])).size, 0);
});

test('XFA: "endstream" darf den nächsten Datenstrom nicht verschlucken', () => {
  // "endstream" enthält selbst "stream" – wird davon nicht hinweggesprungen, gilt der
  // Abschluss des einen Stroms als Anfang des nächsten und jeder zweite geht verloren.
  const xml = '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>';
  const pdf = Buffer.from(
    '%PDF-1.4\n/XFA\n' +
      '1 0 obj\n<< >>\nstream\nirgendwas ohne XFA\nendstream\nendobj\n' +
      `2 0 obj\n<< >>\nstream\n${xml}\nendstream\nendobj\n`,
    'latin1'
  );

  assert.deepEqual(findXfaStreams(pdf), [xml]);
});

test('XFA: Feldwerte werden gelesen, entschlüsselt und von Auszeichnung befreit', () => {
  const werte = parseXfaFieldValues([
    `<template>
       <field name="einfach"><ui><textEdit/></ui><value><text>Max Mustermann</text></value></field>
       <field name="entitaeten"><value><text>M&#252;ller &amp; S&#246;hne</text></value></field>
       <field name="reich"><value><text><body><p>Erste <b>Zeile</b></p></body></text></value></field>
       <field name="ohneWert"><ui><textEdit/></ui></field>
       <field name="leer"><value><text>   </text></value></field>
       <field name="ankreuz"><ui><checkButton/></ui><value><integer>1</integer></value></field>
     </template>`,
  ]);

  assert.deepEqual(
    [...werte.entries()],
    [
      ['einfach', 'Max Mustermann'],
      ['entitaeten', 'Müller & Söhne'],
      ['reich', 'Erste Zeile'],
    ]
  );
});

test('XFA: Mehrdeutige Feldnamen werden verworfen statt geraten', () => {
  const werte = parseXfaFieldValues([
    '<field name="doppelt"><value><text>Eins</text></value></field>' +
      '<field name="doppelt"><value><text>Zwei</text></value></field>' +
      '<field name="gleich"><value><text>Wert</text></value></field>' +
      '<field name="gleich"><value><text>Wert</text></value></field>',
  ]);

  assert.equal(werte.has('doppelt'), false, 'Bei verschiedenen Werten darf nichts zugeordnet werden');
  assert.equal(werte.get('gleich'), 'Wert', 'Derselbe Wert mehrfach ist kein Widerspruch');
});

test('XFA: Feldname aus dem AcroForm-Pfad ableiten', () => {
  assert.equal(
    xfaLookupName('GMCForm2026_08_03T09_55_03Z[0].BusinessData_nameTitelBezug[0]'),
    'BusinessData_nameTitelBezug'
  );
  assert.equal(xfaLookupName('feld0'), 'feld0');
  assert.equal(xfaLookupName('a.b.c[12]'), 'c');
  assert.equal(xfaLookupName(''), null);
  assert.equal(xfaLookupName(undefined), null);
});

test('XFA: Gezeichnete Werte haben Vorrang vor dem XFA-Teil', async () => {
  // Steht der Wert sowohl gezeichnet als auch im XFA-Teil, zählt das Sichtbare.
  const mitAllem = makeFormFieldPdf(FELDER);
  const { pages } = await extractPages(mitAllem);
  assert.deepEqual(
    pages[0].words.filter((w) => w.formField).map((w) => w.text),
    ['Max', 'Mustermann', '4711', 'EUR']
  );
});
