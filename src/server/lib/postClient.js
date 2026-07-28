import { AppError } from './errors.js';
import { assertPdf } from './validate.js';

/** Standard-Content-Type (siehe README, Klärungspunkt 2). Über Env-Variable überschreibbar. */
export const DEFAULT_CONTENT_TYPE = process.env.SPAC_POST_CONTENT_TYPE || 'text/plain; charset=utf-8';
export const DEFAULT_TIMEOUT_MS = Number(process.env.SPAC_POST_TIMEOUT_MS || 120_000);

/**
 * Führt den POST-Aufruf gegen die Ziel-URL aus (FR2) und liefert das PDF zurück (FR4).
 * Alle Fehler werden in verständliche AppErrors übersetzt (NFR2).
 */
export async function postToTarget({
  targetUrl,
  body,
  contentType = DEFAULT_CONTENT_TYPE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  let response;
  try {
    response = await fetchImpl(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Accept: 'application/pdf, */*',
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new AppError(
        'TARGET_TIMEOUT',
        `Zeitüberschreitung: ${targetUrl} hat innerhalb von ${Math.round(timeoutMs / 1000)} Sekunden nicht geantwortet.`,
        { status: 504, cause: err }
      );
    }
    throw new AppError(
      'TARGET_UNREACHABLE',
      `Die URL ${targetUrl} ist nicht erreichbar (${err?.cause?.code || err?.code || err?.message || 'unbekannter Netzwerkfehler'}). ` +
        'Bitte URL, Netzwerk und ob der Zielservice läuft prüfen.',
      { status: 502, cause: err }
    );
  } finally {
    clearTimeout(timer);
  }

  const arrayBuffer = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
  const buffer = Buffer.from(arrayBuffer);
  const responseContentType = response.headers?.get?.('content-type') || null;

  if (!response.ok) {
    const preview = buffer.subarray(0, 300).toString('utf8').replace(/\s+/g, ' ').trim();
    throw new AppError(
      'TARGET_STATUS',
      `Der Zielservice hat mit HTTP ${response.status}${response.statusText ? ` (${response.statusText})` : ''} geantwortet.` +
        (preview ? ` Meldung: "${preview}"` : ''),
      { status: 502, details: { status: response.status, preview } }
    );
  }

  const pdf = assertPdf(buffer, { source: 'Die Antwort des Zielservice', contentType: responseContentType });

  return {
    pdf,
    status: response.status,
    contentType: responseContentType,
    durationMs: Date.now() - startedAt,
    requestContentType: contentType,
  };
}
