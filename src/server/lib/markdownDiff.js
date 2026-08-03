import { diffTokens, foldSegmentationDifferences, normalizeIgnoringSpaces } from './diff.js';

/**
 * Zeilenweiser Vergleich zweier Markdown-Fassungen, aufbereitet für eine
 * Gegenüberstellung in zwei Spalten.
 *
 * Zeilen, die auf beiden Seiten verändert wurden, werden zu einer Zeile
 * zusammengefasst ("changed") und zusätzlich wortweise ausgezeichnet, damit die
 * eigentliche Änderung sofort ins Auge fällt.
 */

/** Zerlegt zwei geänderte Zeilen in Abschnitte und markiert die abweichenden Wörter. */
export function segmentLine(referenceLine, generatedLine) {
  const referenceWords = referenceLine.split(/(\s+)/).filter((part) => part !== '');
  const generatedWords = generatedLine.split(/(\s+)/).filter((part) => part !== '');

  // Reine Trennungs- und Trennstrichunterschiede sind keine Änderung und werden deshalb
  // auch innerhalb einer Zeile nicht hervorgehoben.
  const ops = foldSegmentationDifferences(
    diffTokens(referenceWords, generatedWords),
    referenceWords,
    generatedWords
  );
  const reference = [];
  const generated = [];

  const push = (target, text, changed) => {
    const last = target[target.length - 1];
    if (last && last.changed === changed) {
      last.text += text;
    } else {
      target.push({ text, changed });
    }
  };

  for (const op of ops) {
    if (op.type === 'equal') {
      push(reference, referenceWords[op.aIndex], false);
      push(generated, generatedWords[op.bIndex], false);
    } else if (op.type === 'segmentation' || op.type === 'hyphenation') {
      // Inhaltlich gleich, nur anders getrennt – auf beiden Seiten unmarkiert übernehmen.
      if (op.aIndex !== null) push(reference, referenceWords[op.aIndex], false);
      if (op.bIndex !== null) push(generated, generatedWords[op.bIndex], false);
    } else if (op.type === 'removed') {
      push(reference, referenceWords[op.aIndex], referenceWords[op.aIndex].trim() !== '');
    } else {
      push(generated, generatedWords[op.bIndex], generatedWords[op.bIndex].trim() !== '');
    }
  }

  return { reference, generated };
}

/**
 * Baut die Zeilen der Gegenüberstellung.
 * @param {string[]} referenceLines
 * @param {string[]} generatedLines
 * @returns {Array<{type:'equal'|'changed'|'removed'|'added', reference:string|null, generated:string|null,
 *                  referenceLine:number|null, generatedLine:number|null, segments?:object}>}
 */
export function buildLineDiff(referenceLines, generatedLines) {
  const ops = diffTokens(referenceLines, generatedLines);
  const rows = [];

  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];

    if (op.type === 'equal') {
      rows.push({
        type: 'equal',
        reference: referenceLines[op.aIndex],
        generated: generatedLines[op.bIndex],
        referenceLine: op.aIndex + 1,
        generatedLine: op.bIndex + 1,
      });
      continue;
    }

    if (op.type === 'removed') {
      // Direkt folgende Einfügungen als Änderung derselben Zeile darstellen.
      const removed = [];
      while (index < ops.length && ops[index].type === 'removed') {
        removed.push(ops[index]);
        index += 1;
      }
      const added = [];
      while (index < ops.length && ops[index].type === 'added') {
        added.push(ops[index]);
        index += 1;
      }
      index -= 1;

      const paare = Math.max(removed.length, added.length);
      for (let position = 0; position < paare; position += 1) {
        const links = removed[position] ?? null;
        const rechts = added[position] ?? null;
        const referenceText = links ? referenceLines[links.aIndex] : null;
        const generatedText = rechts ? generatedLines[rechts.bIndex] : null;

        // Unterscheiden sich zwei Zeilen nur in der Wortrennung – etwa weil ein
        // Sonderzeichen als eigenes Textelement kodiert ist –, ist das keine Abweichung.
        const nurAndersGetrennt =
          links &&
          rechts &&
          normalizeIgnoringSpaces(referenceText) === normalizeIgnoringSpaces(generatedText);

        if (nurAndersGetrennt) {
          rows.push({
            type: 'equal',
            reference: referenceText,
            generated: generatedText,
            referenceLine: links.aIndex + 1,
            generatedLine: rechts.bIndex + 1,
          });
          continue;
        }

        rows.push({
          type: links && rechts ? 'changed' : links ? 'removed' : 'added',
          reference: referenceText,
          generated: generatedText,
          referenceLine: links ? links.aIndex + 1 : null,
          generatedLine: rechts ? rechts.bIndex + 1 : null,
          ...(links && rechts ? { segments: segmentLine(referenceText, generatedText) } : {}),
        });
      }
      continue;
    }

    // Reine Einfügung ohne vorangehende Löschung
    rows.push({
      type: 'added',
      reference: null,
      generated: generatedLines[op.bIndex],
      referenceLine: null,
      generatedLine: op.bIndex + 1,
    });
  }

  const changed = rows.filter((row) => row.type !== 'equal');
  return {
    rows,
    totals: {
      equal: rows.length - changed.length,
      changed: rows.filter((row) => row.type === 'changed').length,
      removed: rows.filter((row) => row.type === 'removed').length,
      added: rows.filter((row) => row.type === 'added').length,
    },
    identical: changed.length === 0,
  };
}
