import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { AppError, isAppError } from './lib/errors.js';
import { buildPostBody } from './lib/buildPostBody.js';
import { comparePdfs } from './lib/comparePdfs.js';
import { buildRequest, postToTarget, DEFAULT_CONTENT_TYPE, DEFAULT_TIMEOUT_MS } from './lib/postClient.js';
import { compareRequests } from './lib/requestDiff.js';
import { PdfStore } from './lib/store.js';
import { logger, DEFAULT_LOG_FILE } from './lib/logger.js';
import { buildCurlCommand, parseHeaderLines } from './lib/httpHeaders.js';
import { assertPdf, validateTargetUrl, validateTemplatePath, validateXmlContent } from './lib/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(here, '../../public');
const MAX_BODY = process.env.SPAC_MAX_UPLOAD || '75mb';

/** Maximale Größe der Body-Vorschau in der Diagnose-Ausgabe. */
const BODY_PREVIEW_LIMIT = 20_000;

/**
 * Baut die Header eines eingehenden Requests mit ihrer ursprünglichen Schreibweise auf.
 * Node stellt in `req.headers` nur kleingeschriebene Namen bereit; für die Übernahme in
 * das Feld „Zusätzliche Header" ist die Originalschreibweise aber die verständlichere.
 */
export function originalCaseHeaders(rawHeaders = [], fallback = {}) {
  const headers = {};
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const wert = rawHeaders[index + 1];
    headers[name] = headers[name] === undefined ? wert : `${headers[name]}, ${wert}`;
  }
  return Object.keys(headers).length > 0 ? headers : { ...fallback };
}

/**
 * Baut die Express-App. `transport` ist injizierbar (node:http-kompatibel),
 * damit Tests den Zielservice bei Bedarf mocken können.
 */
export function createApp({
  transport = null,
  store = new PdfStore(),
  publicDir = PUBLIC_DIR,
  log = logger,
  logBodies = process.env.SPAC_LOG_BODY === '1',
} = {}) {
  const app = express();
  app.disable('x-powered-by');

  /**
   * Aufzeichnungs-Endpunkt: nimmt eine beliebige Anfrage entgegen und merkt sie sich
   * unverändert. Damit lässt sich ein funktionierender Aufruf aus einem anderen Werkzeug
   * (z. B. Postman) mit dem vergleichen, was diese Anwendung senden würde.
   *
   * Muss vor den globalen Body-Parsern stehen, damit der Rohkörper unangetastet bleibt.
   */
  let capturedRequest = null;
  app.all('/api/capture', express.raw({ type: () => true, limit: MAX_BODY }), (req, res, next) => {
    // GET/DELETE steuern die Aufzeichnung und werden weiter unten behandelt.
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return next();

    const bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    capturedRequest = {
      method: req.method,
      path: req.originalUrl,
      httpVersion: req.httpVersion,
      // Über rawHeaders, damit die ursprüngliche Schreibweise erhalten bleibt
      // (req.headers ist komplett kleingeschrieben).
      headers: originalCaseHeaders(req.rawHeaders, req.headers),
      bodyBuffer,
      receivedAt: new Date().toISOString(),
    };
    log.info(`Anfrage aufgezeichnet: ${req.method} ${req.originalUrl}, ${bodyBuffer.length} Bytes`);
    res.type('text/plain; charset=utf-8').send(
      `Anfrage aufgezeichnet (${bodyBuffer.length} Bytes).\n` +
        'Zurück im PDF-Vergleichstool auf "Vergleichen" klicken.\n'
    );
  });

  app.use(express.json({ limit: MAX_BODY }));
  app.use(express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: MAX_BODY }));
  app.use(express.static(publicDir, { index: 'index.html', maxAge: 0 }));

  app.locals.store = store;

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: 1, storedPdfs: store.size });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      postContentType: DEFAULT_CONTENT_TYPE,
      postTimeoutMs: DEFAULT_TIMEOUT_MS,
      diffMethod: 'text-extraction',
      templatePathValidation: 'non-empty-string',
      logFile: log.file || DEFAULT_LOG_FILE,
      logBodies,
    });
  });

  /** Status der Aufzeichnung – die Oberfläche fragt hier, ob schon etwas eingetroffen ist. */
  app.get('/api/capture', (_req, res) => {
    if (!capturedRequest) {
      return res.json({ received: false });
    }
    res.json({
      received: true,
      request: {
        method: capturedRequest.method,
        path: capturedRequest.path,
        headers: capturedRequest.headers,
        bytes: capturedRequest.bodyBuffer.length,
        body: capturedRequest.bodyBuffer.toString('utf8'),
        receivedAt: capturedRequest.receivedAt,
      },
    });
  });

  app.delete('/api/capture', (_req, res) => {
    capturedRequest = null;
    res.json({ received: false });
  });

  /**
   * Vergleicht die aufgezeichnete Anfrage mit der, die die Anwendung mit den
   * aktuellen Eingaben senden würde. Es wird dabei nichts an den Zielservice gesendet.
   */
  app.post('/api/capture/compare', (req, res, next) => {
    try {
      if (!capturedRequest) {
        throw new AppError(
          'NO_CAPTURE',
          'Es wurde noch keine Anfrage aufgezeichnet. Bitte den Aufruf aus dem anderen Werkzeug an die angezeigte URL senden.',
          { status: 409 }
        );
      }

      const { templatePath, xmlContent, xmlFileName, contentType, extraHeaders, lineEnding } = req.body ?? {};
      const template = validateTemplatePath(templatePath);
      validateXmlContent(xmlContent, xmlFileName || 'Test-XML');

      const eigener = buildRequest({
        targetUrl: 'http://vergleich.lokal/',
        body: buildPostBody({ templatePath: template, xmlContent, lineEnding }),
        contentType: typeof contentType === 'string' && contentType.trim() ? contentType.trim() : undefined,
        extraHeaders: parseHeaderLines(extraHeaders),
      });

      res.json({
        comparison: compareRequests(
          { method: 'POST', headers: eigener.headers, bodyBuffer: eigener.bodyBuffer },
          {
            method: capturedRequest.method,
            headers: capturedRequest.headers,
            bodyBuffer: capturedRequest.bodyBuffer,
          }
        ),
        application: { body: eigener.body, bytes: eigener.bytes, headers: eigener.headers },
        captured: {
          body: capturedRequest.bodyBuffer.toString('utf8'),
          bytes: capturedRequest.bodyBuffer.length,
          receivedAt: capturedRequest.receivedAt,
          path: capturedRequest.path,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /** FR1: Referenz-PDF hochladen (roher Datei-Upload, kein multipart nötig). */
  app.post('/api/reference', (req, res, next) => {
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.length === 0) {
        throw new AppError(
          'REFERENCE_REQUIRED',
          'Es wurde keine Referenz-PDF-Datei übertragen. Bitte eine PDF-Datei auswählen.'
        );
      }
      const fileName = decodeURIComponent(req.get('x-file-name') || 'referenz.pdf');
      assertPdf(body, { source: `Die Datei "${fileName}"`, contentType: req.get('content-type') });

      const referenceId = store.put(body, { kind: 'reference', fileName });
      res.status(201).json({ referenceId, fileName, bytes: body.length });
    } catch (err) {
      next(err);
    }
  });

  /**
   * FR2/FR3/FR4/FR5/FR6 – und über wiederholten Aufruf mit denselben Werten auch FR7 (Refresh).
   */
  app.post('/api/generate', async (req, res, next) => {
    try {
      const { targetUrl, templatePath, xmlContent, xmlFileName, referenceId, contentType, extraHeaders, lineEnding } =
        req.body ?? {};

      const url = validateTargetUrl(targetUrl);
      const template = validateTemplatePath(templatePath);
      validateXmlContent(xmlContent, xmlFileName || 'Test-XML');
      const zusatzHeader = parseHeaderLines(extraHeaders);

      const reference = referenceId ? store.get(referenceId) : null;
      if (referenceId && !reference) {
        throw new AppError(
          'REFERENCE_NOT_FOUND',
          'Das Referenz-PDF ist auf dem Server nicht mehr vorhanden (z. B. nach einem Serverneustart). Bitte die Datei erneut auswählen.',
          { status: 410 }
        );
      }

      const body = buildPostBody({ templatePath: template, xmlContent, lineEnding });

      let result;
      try {
        result = await postToTarget({
          targetUrl: url,
          body,
          contentType: typeof contentType === 'string' && contentType.trim() ? contentType.trim() : undefined,
          extraHeaders: zusatzHeader,
          transport,
        });
      } catch (err) {
        // Bei einem Fehler den kompletten Austausch protokollieren – inklusive
        // gesendetem Body, Antwort des Zielservice und reproduzierbarem cURL-Aufruf.
        const anfrage = err.exchange?.request ?? { body, bytes: Buffer.byteLength(body, 'utf8') };
        const bodyDatei = log.saveRequestBody(anfrage.bodyBuffer ?? Buffer.from(body, 'utf8'));
        const curl = buildCurlCommand({
          targetUrl: url,
          headers: anfrage.headers ?? {},
          bodyFile: bodyDatei ?? 'body.txt',
        });

        log.logExchange({
          level: 'FEHLER',
          targetUrl: url,
          error: err,
          request: anfrage,
          response: err.exchange?.response ?? null,
          curl,
        });

        err.details = { ...(err.details ?? {}), curl, bodyFile: bodyDatei };
        // Auch an den Request-Auszug hängen, damit die Oberfläche ihn mit anzeigt.
        if (err.details.request) {
          err.details.request.curl = curl;
          err.details.request.bodyFile = bodyDatei;
        }
        throw err;
      }

      const bodyDatei = log.saveRequestBody(result.exchange.request.bodyBuffer);
      const curl = buildCurlCommand({
        targetUrl: url,
        headers: result.requestHeaders,
        bodyFile: bodyDatei ?? 'body.txt',
      });

      if (logBodies) {
        log.logExchange({ level: 'ERFOLG', targetUrl: url, ...result.exchange, curl });
      } else {
        log.info(
          `POST ${url} -> HTTP ${result.status}, ${result.pdf.length} Bytes PDF in ${result.durationMs} ms ` +
            `(gesendet: ${result.requestBytes} Bytes als ${result.requestContentType})`
        );
      }

      const generatedId = store.put(result.pdf, { kind: 'generated', fileName: 'vergleichsdokument.pdf' });

      let comparison = null;
      let comparisonError = null;
      if (reference) {
        try {
          comparison = await comparePdfs(reference.buffer, result.pdf);
        } catch (err) {
          comparisonError = isAppError(err)
            ? err.toJSON().error
            : { code: 'COMPARE_FAILED', message: `Vergleich fehlgeschlagen: ${err.message}` };
          log.info(`FEHLER beim PDF-Vergleich: ${comparisonError.code} – ${comparisonError.message}`);
        }
      }

      res.json({
        generatedId,
        referenceId: reference?.id ?? null,
        generatedUrl: `/api/pdf/${generatedId}`,
        referenceUrl: reference ? `/api/pdf/${reference.id}` : null,
        request: {
          method: 'POST',
          targetUrl: url,
          templatePath: template,
          contentType: result.requestContentType,
          encoding: result.requestEncoding,
          headers: result.requestHeaders,
          curl,
          bodyFile: bodyDatei,
          bodyBytes: result.requestBytes,
          body: body.length > BODY_PREVIEW_LIMIT ? `${body.slice(0, BODY_PREVIEW_LIMIT)}\n… (gekürzt)` : body,
        },
        response: {
          status: result.status,
          contentType: result.contentType,
          bytes: result.pdf.length,
          durationMs: result.durationMs,
        },
        comparison,
        comparisonError,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  /** FR4: Das PDF (generiert oder Referenz) für die Anzeige ausliefern. */
  app.get('/api/pdf/:id', (req, res, next) => {
    try {
      const entry = store.get(req.params.id);
      if (!entry) {
        throw new AppError('PDF_NOT_FOUND', 'Das angeforderte PDF ist nicht (mehr) verfügbar.', { status: 404 });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${entry.fileName || 'dokument.pdf'}"`
      );
      res.send(entry.buffer);
    } catch (err) {
      next(err);
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unbekannter API-Endpunkt.' } });
  });

  // Zentrale Fehlerbehandlung – liefert immer eine verständliche Meldung (NFR2).
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (isAppError(err)) {
      const payload = err.toJSON();
      payload.error.logFile = log.file || DEFAULT_LOG_FILE;
      return res.status(err.status).json(payload);
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({
        error: { code: 'FILE_TOO_LARGE', message: `Die Datei ist zu groß (Limit: ${MAX_BODY}).` },
      });
    }
    if (err instanceof SyntaxError) {
      return res.status(400).json({
        error: { code: 'BAD_JSON', message: 'Die Anfrage konnte nicht gelesen werden (ungültiges JSON).' },
      });
    }
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: `Unerwarteter Serverfehler: ${err?.message || 'unbekannt'}` },
    });
  });

  return app;
}
