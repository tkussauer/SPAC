import http from 'node:http';
import https from 'node:https';
import { AppError } from './errors.js';
import { assertPdf } from './validate.js';
import { mergeHeaders } from './httpHeaders.js';

/** Standard-Content-Type (siehe README, Klärungspunkt 2). Über Env-Variable überschreibbar. */
export const DEFAULT_CONTENT_TYPE = process.env.SPAC_POST_CONTENT_TYPE || 'text/plain; charset=utf-8';
export const DEFAULT_TIMEOUT_MS = Number(process.env.SPAC_POST_TIMEOUT_MS || 120_000);
/**
 * Manche Endpoints und vorgelagerte Firewalls weisen Anfragen ohne User-Agent ab.
 * Über die zusätzlichen Header lässt sich der Wert frei setzen oder mit leerem Wert entfernen.
 */
export const DEFAULT_USER_AGENT = process.env.SPAC_POST_USER_AGENT || 'SPAC-PDF-Vergleichstool/1.0';
/** Bewusst unspezifisch – eine Einschränkung auf application/pdf kann zu HTTP 406 führen. */
export const DEFAULT_ACCEPT = process.env.SPAC_POST_ACCEPT || '*/*';

/**
 * Ermittelt die Byte-Kodierung des Bodys aus dem charset-Parameter des Content-Type.
 * Beispiel: "text/plain; charset=iso-8859-1" -> latin1
 */
export function encodingFromContentType(contentType) {
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType || '')?.[1]?.toLowerCase();
  switch (charset) {
    case undefined:
    case 'utf-8':
    case 'utf8':
      return 'utf8';
    case 'iso-8859-1':
    case 'iso8859-1':
    case 'latin1':
    case 'windows-1252':
    case 'cp1252':
      return 'latin1';
    case 'us-ascii':
    case 'ascii':
      return 'ascii';
    case 'utf-16le':
    case 'utf-16':
      return 'utf16le';
    default:
      return 'utf8';
  }
}

/**
 * Führt den POST-Aufruf gegen die Ziel-URL aus (FR2) und liefert das PDF zurück (FR4).
 *
 * Bewusst direkt über node:http statt über fetch: Der Body wird damit unverändert als
 * Rohdaten gesendet (kein Chunking, keine Multipart-Kodierung) und es gehen ausschließlich
 * die hier aufgeführten Header über die Leitung. fetch/undici ergänzt sonst automatisch
 * Browser-Header wie sec-fetch-mode, accept-language oder accept-encoding, die strikte
 * Endpoints ablehnen können.
 *
 * Alle Fehler werden in verständliche AppErrors übersetzt (NFR2).
 */
/** Größe der Request-/Response-Auszüge, die an die Oberfläche übergeben werden. */
const UI_PREVIEW_LIMIT = 20_000;

function shorten(text, limit = UI_PREVIEW_LIMIT) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… (gekürzt, insgesamt ${value.length} Zeichen)`;
}

export async function postToTarget({
  targetUrl,
  body,
  contentType = DEFAULT_CONTENT_TYPE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  extraHeaders = {},
  transport = null,
}) {
  const url = new URL(targetUrl);
  const encoding = encodingFromContentType(contentType);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), encoding);

  const headers = mergeHeaders(
    {
      'Content-Type': contentType,
      'Content-Length': String(payload.length),
      Accept: DEFAULT_ACCEPT,
      'User-Agent': DEFAULT_USER_AGENT,
    },
    extraHeaders
  );

  /** Vollständige Angaben zum gesendeten Request – für Log und Fehleranzeige. */
  const requestInfo = {
    method: 'POST',
    targetUrl,
    headers,
    body: payload.toString(encoding),
    bodyBuffer: payload,
    bytes: payload.length,
    encoding,
  };

  /** Hängt Request- und Antwortdaten an den Fehler, damit sie geloggt und angezeigt werden können. */
  const withDiagnostics = (appError, response = null) => {
    appError.exchange = { targetUrl, request: requestInfo, response };
    appError.details = {
      ...(appError.details ?? {}),
      request: {
        method: 'POST',
        targetUrl,
        headers,
        body: shorten(requestInfo.body),
        bytes: requestInfo.bytes,
        encoding,
      },
      response: response
        ? {
            status: response.status,
            statusMessage: response.statusMessage,
            headers: response.headers,
            body: shorten(response.body),
            bytes: response.bytes,
          }
        : null,
    };
    return appError;
  };

  const client = transport || (url.protocol === 'https:' ? https : http);
  const startedAt = Date.now();

  const { status, statusMessage, responseHeaders, buffer } = await new Promise((resolve, reject) => {
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            statusMessage: response.statusMessage,
            responseHeaders: response.headers,
            buffer: Buffer.concat(chunks),
          })
        );
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new AppError(
          'TARGET_TIMEOUT',
          `Zeitüberschreitung: ${targetUrl} hat innerhalb von ${Math.round(timeoutMs / 1000)} Sekunden nicht geantwortet.`,
          { status: 504 }
        )
      );
    });

    request.on('error', (err) => {
      if (err instanceof AppError) return reject(withDiagnostics(err));
      reject(
        withDiagnostics(
          new AppError(
            'TARGET_UNREACHABLE',
            `Die URL ${targetUrl} ist nicht erreichbar (${err?.code || err?.message || 'unbekannter Netzwerkfehler'}). ` +
              'Bitte URL, Netzwerk und ob der Zielservice läuft prüfen.',
            { status: 502, cause: err }
          )
        )
      );
    });

    // Rohdaten senden – exakt die Bytes aus dem Body, ohne weitere Kodierung.
    request.end(payload);
  });

  const responseContentType = responseHeaders?.['content-type'] || null;
  const responseInfo = {
    status,
    statusMessage,
    headers: responseHeaders,
    body: buffer.toString('utf8'),
    bytes: buffer.length,
  };

  if (status < 200 || status >= 300) {
    const preview = buffer.subarray(0, 500).toString('utf8').replace(/\s+/g, ' ').trim();
    throw withDiagnostics(
      new AppError(
        'TARGET_STATUS',
        `Der Zielservice hat mit HTTP ${status}${statusMessage ? ` (${statusMessage})` : ''} geantwortet.` +
          (preview ? ` Meldung: "${preview}"` : ''),
        { status: 502, details: { status, preview } }
      ),
      responseInfo
    );
  }

  let pdf;
  try {
    pdf = assertPdf(buffer, { source: 'Die Antwort des Zielservice', contentType: responseContentType });
  } catch (err) {
    throw withDiagnostics(err, responseInfo);
  }

  return {
    pdf,
    status,
    contentType: responseContentType,
    durationMs: Date.now() - startedAt,
    requestContentType: contentType,
    requestHeaders: headers,
    requestBytes: payload.length,
    requestEncoding: encoding,
    exchange: { targetUrl, request: requestInfo, response: { ...responseInfo, body: '<PDF-Daten>' } },
  };
}
