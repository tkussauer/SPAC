/**
 * Frei wählbare Wörter und Wortfolgen, die vom Vergleich ausgenommen werden.
 *
 * Erzeugte Dokumente enthalten regelmäßig technische Marken, die inhaltlich nichts bedeuten –
 * Ebenenkennungen wie `EBENE-V`, Platzhalter oder Vermerke des Erzeugers. Sie stehen nur in
 * einem der beiden Dokumente und wären sonst lauter gemeldete Abweichungen.
 *
 * Die Liste wird als kommagetrennte Angabe erfasst. Ein Eintrag darf mehrere Wörter umfassen
 * (`Daten von S`) – dann muss die Folge zusammenhängend auftreten. `*` steht für beliebig viele
 * Zeichen, sodass `EBENE*` auch `EBENE-E` und `EBENE-V` erfasst.
 */
import { normalizeToken } from './diff.js';

/** Führende Markdown-Auszeichnung (`### `, `- `) entfernen – so lässt sich aus der Ansicht kopieren. */
const MARKDOWN_PREFIX = /^(#{1,6}|[-*+])\s+/;

/**
 * Baut aus einem Wort mit `*` einen Prüfer. Ohne `*` wird auf Gleichheit geprüft.
 * Verglichen wird stets in der Normalform (siehe normalizeToken): ohne Rücksicht auf
 * Groß-/Kleinschreibung, Bindestrich- und Anführungszeichenvarianten.
 */
function baueMuster(wort) {
  const normalisiert = normalizeToken(wort);
  if (!normalisiert.includes('*')) return (text) => text === normalisiert;

  const regex = new RegExp(
    `^${normalisiert
      .split('*')
      .map((teil) => teil.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'u'
  );
  return (text) => regex.test(text);
}

/**
 * Zerlegt die kommagetrennte Angabe in Wortfolgen.
 * @returns {Array<{label:string, matcher:Array<(text:string)=>boolean>}>}
 */
export function parseIgnoreWords(eingabe) {
  if (typeof eingabe !== 'string' || eingabe.trim() === '') return [];

  return eingabe
    .split(',')
    .map((eintrag) => eintrag.trim().replace(MARKDOWN_PREFIX, '').trim())
    .filter((eintrag) => eintrag !== '')
    .map((eintrag) => ({
      label: eintrag,
      matcher: eintrag.split(/\s+/).map(baueMuster),
    }))
    .filter((eintrag) => eintrag.matcher.length > 0);
}

/** Passt die Wortfolge ab dieser Stelle? */
function passtAb(normalisiert, start, matcher) {
  if (start + matcher.length > normalisiert.length) return false;
  for (let index = 0; index < matcher.length; index += 1) {
    if (!matcher[index](normalisiert[start + index])) return false;
  }
  return true;
}

/**
 * Entfernt alle Vorkommen der angegebenen Wortfolgen aus einer Wortliste.
 *
 * Gesucht wird von links nach rechts; eine erkannte Folge wird vollständig übersprungen, sodass
 * sich Treffer nicht überlappen. Längere Einträge werden zuerst geprüft – sonst würde bei
 * `EBENE` und `EBENE-V` immer nur der kürzere greifen.
 *
 * @returns {{words: Array, removed: number}}
 */
export function withoutIgnoredWords(words, eintraege) {
  if (!Array.isArray(eintraege) || eintraege.length === 0) return { words, removed: 0 };

  const sortiert = [...eintraege].sort((a, b) => b.matcher.length - a.matcher.length);
  const normalisiert = words.map((word) => normalizeToken(word.text));
  const behalten = [];
  let removed = 0;

  for (let index = 0; index < words.length; ) {
    const treffer = sortiert.find((eintrag) => passtAb(normalisiert, index, eintrag.matcher));
    if (treffer) {
      index += treffer.matcher.length;
      removed += treffer.matcher.length;
      continue;
    }
    behalten.push(words[index]);
    index += 1;
  }

  return { words: behalten, removed };
}
