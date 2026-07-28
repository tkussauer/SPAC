import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');

export const DEFAULT_LOG_FILE = process.env.SPAC_LOG_FILE || path.join(ROOT, 'logs', 'spac.log');
/** Maximale Zeichenzahl, die je Body ins Log geschrieben wird. */
export const MAX_BODY_CHARS = Number(process.env.SPAC_LOG_MAX_BODY || 100_000);
/** Ab dieser Größe wird die Logdatei einmalig weggerollt. */
const MAX_LOG_BYTES = Number(process.env.SPAC_LOG_MAX_BYTES || 5_000_000);
const SEPARATOR = '='.repeat(78);

function truncate(text, limit = MAX_BODY_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… (gekürzt, insgesamt ${value.length} Zeichen)`;
}

/** Hexdump der ersten Bytes – deckt Kodierungs- und BOM-Probleme auf. */
export function hexPreview(buffer, byteCount = 64) {
  const bytes = Buffer.from(buffer ?? []).subarray(0, byteCount);
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const slice = bytes.subarray(offset, offset + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${offset.toString(16).padStart(4, '0')}  ${hex}  ${ascii}`);
  }
  return lines.join('\n');
}

function formatHeaders(headers) {
  return Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
    .join('\n');
}

export class Logger {
  constructor({ file = DEFAULT_LOG_FILE, toConsole = true } = {}) {
    this.file = file;
    this.toConsole = toConsole;
  }

  #write(text) {
    if (this.toConsole) process.stdout.write(`${text}\n`);
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_LOG_BYTES) {
        fs.renameSync(this.file, `${this.file}.1`);
      }
      fs.appendFileSync(this.file, `${text}\n`, 'utf8');
    } catch (err) {
      // Logging darf die Anwendung nie zum Absturz bringen.
      if (this.toConsole) process.stdout.write(`  [Log konnte nicht geschrieben werden: ${err.message}]\n`);
    }
  }

  info(message) {
    this.#write(`[${new Date().toISOString()}] ${message}`);
  }

  /**
   * Protokolliert einen POST-Aufruf vollständig: gesendete Header, gesendeter Body
   * (als Text und als Hexdump) sowie die Antwort des Zielservice inklusive Body.
   */
  logExchange({ level = 'FEHLER', targetUrl, error = null, request = {}, response = null }) {
    const lines = [
      SEPARATOR,
      `[${new Date().toISOString()}] ${level}: POST ${targetUrl}`,
    ];

    if (error) {
      lines.push(`Fehlercode: ${error.code || 'UNBEKANNT'}`, `Meldung:    ${error.message}`);
    }

    lines.push(
      '',
      '--- GESENDETER REQUEST ---',
      `POST ${targetUrl}`,
      formatHeaders(request.headers),
      '',
      `--- GESENDETER BODY (${request.bytes ?? 0} Bytes, Kodierung ${request.encoding || 'utf8'}) ---`,
      truncate(request.body)
    );

    if (request.bodyBuffer) {
      lines.push('', '--- BODY-ANFANG ALS HEX ---', hexPreview(request.bodyBuffer));
    }

    if (response) {
      lines.push(
        '',
        `--- ANTWORT: HTTP ${response.status}${response.statusMessage ? ` ${response.statusMessage}` : ''} ---`,
        formatHeaders(response.headers),
        '',
        `--- ANTWORT-BODY (${response.bytes ?? 0} Bytes) ---`,
        truncate(response.body)
      );
    } else {
      lines.push('', '--- ANTWORT ---', 'Keine Antwort erhalten (Verbindungs- oder Zeitfehler).');
    }

    lines.push(SEPARATOR);
    this.#write(lines.join('\n'));
  }
}

export const logger = new Logger();
