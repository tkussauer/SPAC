import { AppError } from './errors.js';

const BOM = '﻿';

/** Erkennt eine (einzeilige) XML-Deklaration wie <?xml version="1.0" encoding="UTF-8" standalone="yes"?> */
const XML_DECLARATION_LINE = /^\s*<\?xml\b[^>]*\?>\s*$/i;

/** Zeilenenden vereinheitlichen (CRLF/CR -> LF), damit der Body deterministisch ist. */
export function normalizeLineEndings(text) {
  return String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * Entfernt die erste Zeile der XML-Datei, sofern es sich um die XML-Deklaration handelt (FR3).
 * Vorangestellte Leerzeilen werden dabei mit verworfen.
 * Enthält die Datei keine Deklaration, bleibt der Inhalt unverändert (dokumentierte Annahme).
 */
export function stripXmlDeclaration(xmlContent) {
  const normalized = normalizeLineEndings(xmlContent);
  const lines = normalized.split('\n');

  let firstNonEmpty = 0;
  while (firstNonEmpty < lines.length && lines[firstNonEmpty].trim() === '') {
    firstNonEmpty += 1;
  }

  if (firstNonEmpty < lines.length && XML_DECLARATION_LINE.test(lines[firstNonEmpty])) {
    return lines.slice(firstNonEmpty + 1).join('\n');
  }
  return normalized;
}

/** Erkennt die vorherrschenden Zeilenenden eines Textes. */
export function detectLineEnding(text) {
  const crlf = (String(text).match(/\r\n/g) ?? []).length;
  const lf = (String(text).match(/(^|[^\r])\n/g) ?? []).length;
  if (crlf > 0 && crlf >= lf) return '\r\n';
  return '\n';
}

/**
 * Baut den POST-Body gemäß FR3:
 *   Zeile 1: Vorlagepfad
 *   Zeile 2: leer
 *   ab Zeile 3: Inhalt der Test-XML ohne XML-Deklaration
 *
 * **Ohne Test-XML** besteht der Body nur aus dem Vorlagepfad. Das ist der Fall, in dem ein
 * Dokument allein aus der Vorlage erzeugt werden soll – etwa um zu prüfen, ob dessen
 * Formularfelder überhaupt bedienbar sind. Ein leerer Rumpf mit zwei Zeilenumbrüchen wäre
 * kein leerer Inhalt, sondern Leerraum, den der Zielservice zu deuten versuchen müsste.
 *
 * @param {'lf'|'crlf'|'keep'} lineEnding Zeilenenden des Bodys. "keep" übernimmt die
 *        Zeilenenden der XML-Datei unverändert – manche Endpoints reagieren darauf.
 */
export function buildPostBody({ templatePath, xmlContent, lineEnding = 'lf' }) {
  if (typeof templatePath !== 'string' || templatePath.trim() === '') {
    throw new AppError('TEMPLATE_PATH_REQUIRED', 'Bitte einen Vorlagepfad angeben.');
  }
  const path = normalizeLineEndings(templatePath).split('\n')[0].trim();
  if (typeof xmlContent !== 'string' || xmlContent.trim() === '') return path;

  const xmlBody = stripXmlDeclaration(xmlContent);

  if (lineEnding === 'keep') {
    // Zeilenenden der Originaldatei beibehalten; die beiden Kopfzeilen folgen derselben Schreibweise.
    const original = String(xmlContent).replace(/^﻿/, '');
    const trenner = detectLineEnding(original);
    const körper = stripXmlDeclarationKeepEndings(original);
    return `${path}${trenner}${trenner}${körper}`;
  }

  const trenner = lineEnding === 'crlf' ? '\r\n' : '\n';
  const körper = trenner === '\n' ? xmlBody : xmlBody.replace(/\n/g, '\r\n');
  return `${path}${trenner}${trenner}${körper}`;
}

/** Wie stripXmlDeclaration, aber ohne die Zeilenenden zu vereinheitlichen. */
export function stripXmlDeclarationKeepEndings(xmlContent) {
  const text = String(xmlContent).replace(/^﻿/, '');
  const match = /^(\s*)<\?xml\b[^>]*\?>[ \t]*(\r\n|\r|\n)?/i.exec(text);
  if (!match) return text;
  // Nur entfernen, wenn vor der Deklaration ausschließlich Leerraum steht.
  return text.slice(match[0].length);
}

export { BOM };
