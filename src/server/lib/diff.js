/**
 * Wort-Diff auf Basis der längsten gemeinsamen Teilfolge (LCS).
 * Bewusst dependency-frei, damit die Anwendung offline lauffähig bleibt (NFR1).
 */

/**
 * Normalisierung für den Vergleich. Vereinheitlicht Schreibweisen, die optisch identisch
 * sind, in PDFs aber unterschiedlich kodiert sein können – sonst würden solche Stellen
 * fälschlich als Abweichung gemeldet:
 *  - Unicode-Zusammensetzung (zerlegtes "a"+Trema vs. zusammengesetztes "ä")
 *  - unsichtbare Steuerzeichen (weiches Trennzeichen, Zero-Width-Zeichen)
 *  - Leerzeichen-Varianten (geschütztes, schmales, halbes Leerzeichen)
 *  - Bindestrich- und Anführungszeichen-Varianten
 */
export function normalizeToken(token) {
  return String(token)
    .normalize('NFC')
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .trim()
    .toLowerCase();
}

/**
 * Berechnet Diff-Operationen zwischen zwei Token-Listen.
 * @returns {Array<{type:'equal'|'removed'|'added', aIndex:number|null, bIndex:number|null}>}
 */
export function diffTokens(a, b) {
  const n = a.length;
  const m = b.length;
  const normA = a.map(normalizeToken);
  const normB = b.map(normalizeToken);

  // LCS-Längentabelle (Uint32Array für kompakte Speicherung).
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        normA[i] === normB[j]
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (normA[i] === normB[j]) {
      ops.push({ type: 'equal', aIndex: i, bIndex: j });
      i += 1;
      j += 1;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      ops.push({ type: 'removed', aIndex: i, bIndex: null });
      i += 1;
    } else {
      ops.push({ type: 'added', aIndex: null, bIndex: j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'removed', aIndex: i, bIndex: null });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'added', aIndex: null, bIndex: j });
    j += 1;
  }
  return ops;
}

/** Anteil übereinstimmender Tokens (0..1). Zwei leere Listen gelten als identisch. */
export function similarity(ops) {
  const equal = ops.filter((op) => op.type === 'equal' || op.type === 'segmentation').length;
  if (ops.length === 0) return 1;
  return Math.round((equal / ops.length) * 1000) / 1000;
}

/** Vergleichsform ohne jeden Leerraum – für die Erkennung reiner Trennungsunterschiede. */
export function normalizeIgnoringSpaces(text) {
  return normalizeToken(text).replace(/\s+/g, '');
}

/**
 * Markiert Läufe aus Löschungen und Einfügungen, die zusammengesetzt denselben Text
 * ergeben, als "segmentation" statt als Abweichung.
 *
 * Hintergrund: PDFs kodieren Sonderzeichen gelegentlich als eigenes Textelement. Aus
 * "Selbstständige(r)" wird dann "Selbstst", "ä", "ndige(r)" – inhaltlich identisch, nur
 * anders getrennt. Solche Stellen sind keine Abweichung und dürfen nicht gemeldet werden.
 */
export function foldSegmentationDifferences(ops, a, b) {
  const ergebnis = [];
  let index = 0;

  while (index < ops.length) {
    if (ops[index].type === 'equal') {
      ergebnis.push(ops[index]);
      index += 1;
      continue;
    }

    let ende = index;
    const entfernt = [];
    const ergaenzt = [];
    while (ende < ops.length && ops[ende].type !== 'equal') {
      if (ops[ende].type === 'removed') entfernt.push(a[ops[ende].aIndex]);
      else ergaenzt.push(b[ops[ende].bIndex]);
      ende += 1;
    }

    const nurAndersGetrennt =
      entfernt.length > 0 &&
      ergaenzt.length > 0 &&
      normalizeIgnoringSpaces(entfernt.join('')) === normalizeIgnoringSpaces(ergaenzt.join(''));

    for (const op of ops.slice(index, ende)) {
      ergebnis.push(nurAndersGetrennt ? { ...op, type: 'segmentation' } : op);
    }
    index = ende;
  }

  return ergebnis;
}
