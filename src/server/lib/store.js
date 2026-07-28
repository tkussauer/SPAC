import { randomUUID } from 'node:crypto';

/**
 * Einfacher In-Memory-Speicher für hochgeladene bzw. generierte PDFs.
 * Bewusst ohne Persistenz: Die Anwendung läuft lokal für genau einen Nutzer (NFR1/NFR4).
 */
export class PdfStore {
  constructor({ maxEntries = 20 } = {}) {
    this.entries = new Map();
    this.maxEntries = maxEntries;
  }

  put(buffer, meta = {}) {
    const id = randomUUID();
    this.entries.set(id, {
      id,
      buffer: Buffer.from(buffer),
      createdAt: new Date().toISOString(),
      ...meta,
    });
    this.#evict();
    return id;
  }

  get(id) {
    return this.entries.get(id) ?? null;
  }

  has(id) {
    return this.entries.has(id);
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }

  #evict() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }
}
