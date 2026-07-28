import { AppError } from './errors.js';

const PDF_MAGIC = '%PDF-';

/**
 * Prüft die Ziel-URL (FR1/NFR2). Erlaubt sind nur http/https.
 */
export function validateTargetUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new AppError('URL_REQUIRED', 'Bitte eine Ziel-URL für den POST-Aufruf angeben.');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new AppError(
      'URL_INVALID',
      `Die Ziel-URL "${rawUrl.trim()}" ist keine gültige URL. Erwartet wird z. B. http://server:8080/generate.`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(
      'URL_PROTOCOL_UNSUPPORTED',
      `Das Protokoll "${parsed.protocol.replace(':', '')}" wird nicht unterstützt. Bitte http:// oder https:// verwenden.`
    );
  }
  return parsed.toString();
}

/** Vorlagepfad: freier String, nur auf "nicht leer" geprüft (siehe README, Klärungspunkt 4). */
export function validateTemplatePath(templatePath) {
  if (typeof templatePath !== 'string' || templatePath.trim() === '') {
    throw new AppError('TEMPLATE_PATH_REQUIRED', 'Bitte einen Vorlagepfad angeben.');
  }
  return templatePath.trim();
}

/** Grobe Plausibilitätsprüfung des XML-Inhalts (NFR2). */
export function validateXmlContent(xmlContent, fileName = 'Test-XML') {
  if (typeof xmlContent !== 'string' || xmlContent.trim() === '') {
    throw new AppError(
      'XML_REQUIRED',
      'Bitte eine Test-XML-Datei auswählen. Die gewählte Datei ist leer oder konnte nicht gelesen werden.'
    );
  }
  if (!xmlContent.includes('<')) {
    throw new AppError(
      'XML_INVALID',
      `Die Datei "${fileName}" enthält kein XML (kein einziges "<"-Zeichen gefunden).`
    );
  }
  return xmlContent;
}

/** Erkennt anhand der Magic Bytes, ob ein Buffer ein PDF ist (NFR2). */
export function looksLikePdf(buffer) {
  if (!buffer || buffer.length < PDF_MAGIC.length) return false;
  return Buffer.from(buffer).subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC;
}

/** Wirft einen verständlichen Fehler, wenn der Buffer kein PDF ist. */
export function assertPdf(buffer, { source = 'Antwort', contentType = null } = {}) {
  if (looksLikePdf(buffer)) return Buffer.from(buffer);

  const preview = Buffer.from(buffer || []).subarray(0, 200).toString('utf8').replace(/\s+/g, ' ').trim();
  throw new AppError(
    'INVALID_PDF',
    `${source} ist kein gültiges PDF${contentType ? ` (Content-Type: ${contentType})` : ''}.` +
      (preview ? ` Anfang der Antwort: "${preview}"` : ' Die Antwort war leer.'),
    { status: 502, details: { preview, contentType } }
  );
}

export { PDF_MAGIC };
