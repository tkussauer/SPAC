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

/**
 * Baut den POST-Body gemäß FR3:
 *   Zeile 1: Vorlagepfad
 *   Zeile 2: leer
 *   ab Zeile 3: Inhalt der Test-XML ohne XML-Deklaration
 */
export function buildPostBody({ templatePath, xmlContent }) {
  if (typeof templatePath !== 'string' || templatePath.trim() === '') {
    throw new AppError('TEMPLATE_PATH_REQUIRED', 'Bitte einen Vorlagepfad angeben.');
  }
  if (typeof xmlContent !== 'string' || xmlContent.trim() === '') {
    throw new AppError('XML_REQUIRED', 'Bitte eine Test-XML-Datei auswählen (Datei ist leer oder wurde nicht gelesen).');
  }

  const path = normalizeLineEndings(templatePath).split('\n')[0].trim();
  const xmlBody = stripXmlDeclaration(xmlContent);
  return `${path}\n\n${xmlBody}`;
}

export { BOM };
