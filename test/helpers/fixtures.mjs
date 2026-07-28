import http from 'node:http';
import net from 'node:net';
import PDFDocument from 'pdfkit';
import { createApp } from '../../src/server/app.js';
import { PdfStore } from '../../src/server/lib/store.js';
import { Logger } from '../../src/server/lib/logger.js';

/**
 * Erzeugt ein PDF im Speicher.
 * @param {string[][]} pages Zeilen je Seite, z. B. [['Seite 1 Zeile A'], ['Seite 2']]
 */
export function makePdf(pages) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    pages.forEach((lines, index) => {
      if (index > 0) doc.addPage();
      doc.fontSize(14);
      for (const line of lines) doc.text(line);
    });
    doc.end();
  });
}

/** Startet einen HTTP-Server und liefert Basis-URL + close(). */
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Mock des Ziel-Endpoints. Zeichnet alle eingehenden Requests auf.
 * @param {(req, requestBody) => {status?:number, contentType?:string, body?:Buffer|string}} handler
 */
export async function startMockTarget(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw.toString('utf8'),
        rawBody: raw,
      };
      requests.push(record);
      const result = (await handler(record, requests.length)) || {};
      res.statusCode = result.status ?? 200;
      res.setHeader('Content-Type', result.contentType ?? 'application/pdf');
      res.end(result.body ?? Buffer.alloc(0));
    });
  });
  const handle = await listen(server);
  return { ...handle, requests };
}

/**
 * Roher TCP-Server: zeichnet die Bytes auf, die tatsächlich über die Leitung gehen.
 * Damit lässt sich prüfen, dass der Body unverändert als Rohtext gesendet wird.
 */
export async function startRawTarget({ responseBody = Buffer.from('%PDF-1.4\n%%EOF') } = {}) {
  const captured = [];
  const server = net.createServer((socket) => {
    let raw = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const head = raw.subarray(0, headerEnd).toString('latin1');
      const contentLength = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
      const bodyBytes = raw.subarray(headerEnd + 4);
      if (bodyBytes.length < contentLength) return;

      captured.push({
        raw,
        head,
        headerLines: head.split('\r\n'),
        requestLine: head.split('\r\n')[0],
        headers: Object.fromEntries(
          head
            .split('\r\n')
            .slice(1)
            .map((line) => {
              const index = line.indexOf(':');
              return [line.slice(0, index).toLowerCase().trim(), line.slice(index + 1).trim()];
            })
        ),
        bodyBytes: bodyBytes.subarray(0, contentLength),
        body: bodyBytes.subarray(0, contentLength).toString('utf8'),
      });

      socket.end(
        Buffer.concat([
          Buffer.from(
            `HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: ${responseBody.length}\r\nConnection: close\r\n\r\n`,
            'latin1'
          ),
          responseBody,
        ])
      );
    });
  });
  const handle = await listen(server);
  return { ...handle, captured };
}

/** Startet die Anwendung selbst (echter HTTP-Server). Standardmäßig ohne Logausgabe. */
export async function startApp(options = {}) {
  const app = createApp({
    store: new PdfStore(),
    log: new Logger({ file: null, toConsole: false }),
    ...options,
  });
  const server = http.createServer(app);
  const handle = await listen(server);
  return { ...handle, app };
}

/** Lädt ein Referenz-PDF in die laufende App und liefert die referenceId. */
export async function uploadReference(appUrl, pdfBuffer, fileName = 'referenz.pdf') {
  const response = await fetch(`${appUrl}/api/reference`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(fileName) },
    body: pdfBuffer,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Upload fehlgeschlagen: ${JSON.stringify(data)}`);
  return data.referenceId;
}

export const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<rechnung nummer="4711">
  <position>Artikel A</position>
  <position>Artikel B</position>
</rechnung>
`;

export const SAMPLE_TEMPLATE_PATH = 'C:\\Vorlagen\\rechnung.tpl';
