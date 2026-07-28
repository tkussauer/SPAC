/**
 * Wandelt die aus einem PDF extrahierten Wörter in eine Markdown-Darstellung um.
 * Ziel ist eine gut lesbare, zeilenweise vergleichbare Textfassung des Dokuments –
 * keine originalgetreue Layout-Rekonstruktion.
 */

/** Zeichen, die am Zeilenanfang als Aufzählungspunkt gelten. */
const BULLET_PREFIX = /^[•·▪◦*‣-]\s*/;

/**
 * Gruppiert Wörter anhand ihrer y-Position zu Zeilen und sortiert sie von links nach rechts.
 * @param {Array<{text:string, box:{x:number,y:number,width:number,height:number}}>} words
 */
export function groupWordsIntoLines(words) {
  const lines = [];

  for (const word of [...words].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
    const tolerance = Math.max(word.box.height * 0.5, 2);
    const line = lines.find((candidate) => Math.abs(candidate.y - word.box.y) <= tolerance);
    if (line) {
      line.words.push(word);
      line.height = Math.max(line.height, word.box.height);
    } else {
      lines.push({ y: word.box.y, height: word.box.height, words: [word] });
    }
  }

  return lines
    .sort((a, b) => a.y - b.y)
    .map((line) => ({
      y: line.y,
      height: line.height,
      x: Math.min(...line.words.map((w) => w.box.x)),
      text: line.words
        .sort((a, b) => a.box.x - b.box.x)
        .map((w) => w.text)
        .join(' '),
    }));
}

/** Median der Zeilenhöhen – dient als Bezugsgröße für die Überschriftenerkennung. */
function medianHeight(lines) {
  const heights = lines.map((line) => line.height).sort((a, b) => a - b);
  if (heights.length === 0) return 0;
  const middle = Math.floor(heights.length / 2);
  return heights.length % 2 === 0 ? (heights[middle - 1] + heights[middle]) / 2 : heights[middle];
}

/**
 * Erzeugt die Markdown-Zeilen einer Seite.
 * Deutlich größere Schrift wird als Überschrift interpretiert, führende
 * Aufzählungszeichen werden zu Markdown-Listenpunkten.
 */
export function pageToMarkdownLines(page) {
  const lines = groupWordsIntoLines(page.words ?? []);
  const median = medianHeight(lines);

  const markdownLines = [`## Seite ${page.pageNumber}`, ''];
  for (const line of lines) {
    const text = line.text.trim();
    if (text === '') continue;

    if (BULLET_PREFIX.test(text)) {
      markdownLines.push(`- ${text.replace(BULLET_PREFIX, '')}`);
    } else if (median > 0 && line.height >= median * 1.25) {
      markdownLines.push(`### ${text}`);
    } else {
      markdownLines.push(text);
    }
  }
  markdownLines.push('');
  return markdownLines;
}

/**
 * Erzeugt das Markdown-Dokument zu allen Seiten.
 * @returns {{text:string, lines:string[]}}
 */
export function pagesToMarkdown(pages) {
  const lines = [];
  for (const page of pages) {
    lines.push(...pageToMarkdownLines(page));
  }
  // Abschließende Leerzeile entfernen, damit der Vergleich nicht daran hängen bleibt.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { text: lines.join('\n'), lines };
}
