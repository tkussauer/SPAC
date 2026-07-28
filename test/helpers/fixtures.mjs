import http from 'node:http';
import PDFDocument from 'pdfkit';
import { createApp } from '../../src/server/app.js';
import { PdfStore } from '../../src/server/lib/store.js';

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

/** Startet die Anwendung selbst (echter HTTP-Server, echtes fetch). */
export async function startApp(options = {}) {
  const app = createApp({ store: new PdfStore(), ...options });
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
