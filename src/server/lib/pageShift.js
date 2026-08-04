/**
 * Gleicht Unterschiede aus, die nur daher rühren, dass Text auf einer **anderen Seite** steht.
 *
 * Der Vergleich läuft seitenweise: Seite 1 gegen Seite 1, Seite 2 gegen Seite 2. Schiebt sich
 * der Satz leicht – ein Absatz passt nicht mehr auf die Seite –, rutscht der Text über die
 * Seitengrenze. Derselbe Inhalt wird dann doppelt gemeldet: auf der einen Seite als *fehlend*,
 * auf der nächsten als *zusätzlich*. Inhaltlich ist aber nichts anders.
 *
 * Ein Vergleich über das ganze Dokument hinweg wäre die naheliegende Lösung, scheidet aber aus:
 * Die längste gemeinsame Teilfolge braucht eine Tabelle der Größe n × m – bei zwei Dokumenten
 * mit je 20 000 Wörtern wären das mehrere Gigabyte. Deshalb wird nur **nachträglich** abgeglichen,
 * und zwar allein auf den bereits als unterschiedlich erkannten Wörtern. Die sind wenige.
 */
import { diffTokens } from './diff.js';

/**
 * Obergrenze für den Abgleich. Sind derart viele Wörter unterschiedlich, liegt kein
 * verschobener Satz vor, sondern ein anderes Dokument – dann lohnt der Aufwand nicht.
 */
const MAX_ABGLEICH = 3000;

/**
 * Findet Wörter, die im anderen Dokument nur auf einer benachbarten Seite stehen.
 *
 * @param {Array<{pageIndex:number, text:string}>} missing Wörter der Referenz ohne Entsprechung
 * @param {Array<{pageIndex:number, text:string}>} added Wörter des erzeugten Dokuments ohne Entsprechung
 * @param {number} maxShift Wie viele Seiten Versatz noch als Verschiebung gelten
 * @returns {{missing:Set<number>, added:Set<number>, count:number}} Indizes der verschobenen Einträge
 */
export function matchAcrossPages(missing, added, maxShift = 1) {
  const leer = { missing: new Set(), added: new Set(), count: 0 };
  if (missing.length === 0 || added.length === 0) return leer;
  if (missing.length > MAX_ABGLEICH || added.length > MAX_ABGLEICH) return leer;

  const ops = diffTokens(
    missing.map((eintrag) => eintrag.text),
    added.map((eintrag) => eintrag.text)
  );

  const verschobenMissing = new Set();
  const verschobenAdded = new Set();

  for (const op of ops) {
    if (op.type !== 'equal') continue;
    const links = missing[op.aIndex];
    const rechts = added[op.bIndex];
    // Auf derselben Seite hätte der seitenweise Vergleich die Wörter schon zugeordnet;
    // ein größerer Versatz ist keine Verschiebung mehr, sondern eine andere Stelle.
    if (Math.abs(links.pageIndex - rechts.pageIndex) > maxShift) continue;

    verschobenMissing.add(op.aIndex);
    verschobenAdded.add(op.bIndex);
  }

  return {
    missing: verschobenMissing,
    added: verschobenAdded,
    count: verschobenMissing.size + verschobenAdded.size,
  };
}
