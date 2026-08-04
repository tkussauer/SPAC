import {
  diffTokens,
  foldSegmentationDifferences,
  normalizeIgnoringSpaces,
  normalizeToken,
} from './diff.js';

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

/** Seitenüberschrift der Markdown-Fassung. */
const SEITENUEBERSCHRIFT = /^##\s+Seite\s+(\d+)/;

/** Ordnet jeder Zeile die Seite zu, auf der sie steht. */
function seitenJeZeile(lines) {
  let aktuell = 0;
  return lines.map((line) => {
    const treffer = SEITENUEBERSCHRIFT.exec(line ?? '');
    if (treffer) aktuell = Number(treffer[1]);
    return aktuell;
  });
}

/**
 * Erkennt Zeilen, die im anderen Dokument unverändert auf einer **Nachbarseite** stehen.
 *
 * Ein leichter Versatz im Satz schiebt Text über die Seitengrenze. Zeilenweise verglichen
 * erscheint dieselbe Zeile dann zweimal – einmal als fehlend, einmal als zusätzlich. Beide
 * werden zu "verschoben" umgewidmet, damit die Textfassung dasselbe sagt wie die Seitenansicht.
 */
function markiereVerschobeneZeilen(rows, referenceLines, generatedLines, maxPages) {
  const referenzSeiten = seitenJeZeile(referenceLines);
  const generiertSeiten = seitenJeZeile(generatedLines);

  // Zusätzliche Zeilen nach ihrem Text ablegen; jede kann nur einmal zugeordnet werden.
  const nachText = new Map();
  rows.forEach((row, index) => {
    if (row.type !== 'added') return;
    const key = normalizeToken(row.generated ?? '');
    if (key === '') return;
    if (!nachText.has(key)) nachText.set(key, []);
    nachText.get(key).push(index);
  });

  let count = 0;
  for (const row of rows) {
    if (row.type !== 'removed') continue;
    const key = normalizeToken(row.reference ?? '');
    const kandidaten = nachText.get(key);
    if (!kandidaten || kandidaten.length === 0) continue;

    const referenzSeite = referenzSeiten[row.referenceLine - 1] ?? 0;
    const treffer = kandidaten.findIndex(
      (index) =>
        Math.abs((generiertSeiten[rows[index].generatedLine - 1] ?? 0) - referenzSeite) <= maxPages
    );
    if (treffer === -1) continue;

    const partner = rows[kandidaten[treffer]];
    kandidaten.splice(treffer, 1);
    row.type = 'moved';
    partner.type = 'moved';
    count += 2;
  }

  return count;
}

/**
 * Baut die Zeilen der Gegenüberstellung.
 * @param {string[]} referenceLines
 * @param {string[]} generatedLines
 * @param {{ignorePageShift?:boolean, maxPageShift?:number}} options
 * @returns {Array<{type:'equal'|'changed'|'removed'|'added'|'moved', reference:string|null,
 *                  generated:string|null, referenceLine:number|null, generatedLine:number|null,
 *                  segments?:object}>}
 */
export function buildLineDiff(referenceLines, generatedLines, { ignorePageShift = true, maxPageShift = 1 } = {}) {
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

  const moved = ignorePageShift
    ? markiereVerschobeneZeilen(rows, referenceLines, generatedLines, Math.max(0, Number(maxPageShift) || 0))
    : 0;

  // Verschobene Zeilen sind inhaltlich gleich und zählen deshalb nicht als Abweichung.
  const abweichend = rows.filter((row) => row.type !== 'equal' && row.type !== 'moved');
  return {
    rows,
    totals: {
      equal: rows.length - abweichend.length - moved,
      changed: rows.filter((row) => row.type === 'changed').length,
      removed: rows.filter((row) => row.type === 'removed').length,
      added: rows.filter((row) => row.type === 'added').length,
      moved,
    },
    identical: abweichend.length === 0,
  };
}
