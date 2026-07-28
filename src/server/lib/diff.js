/**
 * Wort-Diff auf Basis der längsten gemeinsamen Teilfolge (LCS).
 * Bewusst dependency-frei, damit die Anwendung offline lauffähig bleibt (NFR1).
 */

/** Normalisierung für den Vergleich: Groß/Kleinschreibung und Whitespace-Varianten ignorieren. */
export function normalizeToken(token) {
  return String(token)
    .replace(/[   ]/g, ' ')
    .replace(/[‐-―]/g, '-')
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
  const equal = ops.filter((op) => op.type === 'equal').length;
  if (ops.length === 0) return 1;
  return Math.round((equal / ops.length) * 1000) / 1000;
}
