import { diffTokens } from './diff.js';
import { describeStyle, styleKey } from './pdfStyle.js';

/**
 * Vergleicht Schriftarten, -größen, -schnitte und Textfarben zweier Dokumente.
 *
 * Zwei Sichten:
 *  1. Inventar – welche Stile kommen in welchem Dokument wie oft vor.
 *  2. Abweichungen – Textstellen, die inhaltlich übereinstimmen, aber anders gesetzt sind.
 */

/** Zählt die verwendeten Stile eines Dokuments. */
export function collectInventory(pages) {
  const inventar = new Map();

  for (const page of pages) {
    for (const word of page.words ?? []) {
      if (!word.style) continue;
      const key = styleKey(word.style);
      const eintrag = inventar.get(key) ?? { key, style: word.style, words: 0, pages: new Set() };
      eintrag.words += 1;
      eintrag.pages.add(page.pageNumber);
      inventar.set(key, eintrag);
    }
  }

  return inventar;
}

/** Benennt die Unterschiede zwischen zwei Stilen. */
export function describeDifferences(reference, generated) {
  const unterschiede = [];
  if (reference.font !== generated.font) unterschiede.push('Schriftart');
  if (reference.size !== generated.size) unterschiede.push('Schriftgröße');
  if (reference.bold !== generated.bold) unterschiede.push('Fettung');
  if (reference.italic !== generated.italic) unterschiede.push('Kursivstellung');
  if (reference.color && generated.color && reference.color !== generated.color) unterschiede.push('Textfarbe');
  return unterschiede;
}

/** Fasst aufeinanderfolgende Wörter mit demselben Stilunterschied zu einem Eintrag zusammen. */
function mergeAdjacent(deviations) {
  const zusammengefasst = [];

  for (const abweichung of deviations) {
    const letzte = zusammengefasst[zusammengefasst.length - 1];
    const gleicheAbweichung =
      letzte &&
      letzte.pageNumber === abweichung.pageNumber &&
      styleKey(letzte.reference) === styleKey(abweichung.reference) &&
      styleKey(letzte.generated) === styleKey(abweichung.generated) &&
      abweichung.wordIndex === letzte.lastWordIndex + 1;

    if (gleicheAbweichung) {
      letzte.text = `${letzte.text} ${abweichung.text}`;
      letzte.words += 1;
      letzte.lastWordIndex = abweichung.wordIndex;
    } else {
      zusammengefasst.push({ ...abweichung, words: 1, lastWordIndex: abweichung.wordIndex });
    }
  }

  return zusammengefasst.map(({ wordIndex, lastWordIndex, ...rest }) => rest);
}

/** Abstandsarten, die erhoben werden. */
const ABSTANDSARTEN = [
  {
    kind: 'line',
    label: 'Zeilenabstand',
    hint: 'Abstand aufeinanderfolgender Zeilen innerhalb eines Textblocks',
  },
  { kind: 'char', label: 'Zeichenabstand', hint: 'Sperrung im Textzustand (Tc)' },
  { kind: 'word', label: 'Wortabstand', hint: 'Zusatz je Leerzeichen im Textzustand (Tw)' },
];

/** Zählt die Abstandsvarianten eines Dokuments je Art und Wert. */
export function collectSpacingInventory(pages) {
  const inventar = new Map();

  for (const page of pages) {
    for (const { kind } of ABSTANDSARTEN) {
      for (const [value, count] of page.spacing?.[kind] ?? []) {
        const key = `${kind}|${value}`;
        const eintrag = inventar.get(key) ?? { key, kind, value, count: 0, pages: new Set() };
        eintrag.count += count;
        eintrag.pages.add(page.pageNumber);
        inventar.set(key, eintrag);
      }
    }
  }

  return inventar;
}

/**
 * Stellt die Abstandsvarianten beider Dokumente gegenüber.
 *
 * Zeilenabstand ergibt sich aus den Positionen, Zeichen- und Wortabstand stehen im
 * Textzustand. Zwei Dokumente können denselben Wortlaut in denselben Schriften zeigen und
 * trotzdem unterschiedlich gesetzt sein – das fällt sonst nirgends auf.
 */
export function compareSpacing(referencePages, generatedPages) {
  const referenz = collectSpacingInventory(referencePages);
  const generiert = collectSpacingInventory(generatedPages);

  const beschriftung = (kind) => ABSTANDSARTEN.find((art) => art.kind === kind) ?? { label: kind };
  const rows = [...new Set([...referenz.keys(), ...generiert.keys()])]
    .map((key) => {
      const links = referenz.get(key) ?? null;
      const rechts = generiert.get(key) ?? null;
      const eintrag = links ?? rechts;

      let status = 'equal';
      if (!links) status = 'only-generated';
      else if (!rechts) status = 'only-reference';
      else if (links.count !== rechts.count) status = 'count-differs';

      return {
        key,
        kind: eintrag.kind,
        value: eintrag.value,
        label: beschriftung(eintrag.kind).label,
        description: `${beschriftung(eintrag.kind).label} ${eintrag.value} pt`,
        status,
        reference: links ? { count: links.count, pages: [...links.pages].sort((a, b) => a - b) } : null,
        generated: rechts ? { count: rechts.count, pages: [...rechts.pages].sort((a, b) => a - b) } : null,
      };
    })
    .sort((a, b) => {
      const reihenfolge = (row) => ABSTANDSARTEN.findIndex((art) => art.kind === row.kind);
      return reihenfolge(a) - reihenfolge(b) || b.value - a.value;
    });

  const nurEinseitig = rows.filter((row) => row.status.startsWith('only-'));
  return {
    kinds: ABSTANDSARTEN,
    rows,
    identical: nurEinseitig.length === 0,
    totals: {
      variants: rows.length,
      onlyInReference: rows.filter((row) => row.status === 'only-reference').length,
      onlyInGenerated: rows.filter((row) => row.status === 'only-generated').length,
    },
  };
}

/**
 * @param {Array} referencePages Seiten des Referenz-PDFs (aus extractPages)
 * @param {Array} generatedPages Seiten des generierten PDFs
 * @param {{colorsResolved?:boolean}} options
 */
export function compareStyles(referencePages, generatedPages, { colorsResolved = true } = {}) {
  // ---------------------------------------------------------------- Inventar
  const referenzInventar = collectInventory(referencePages);
  const generiertInventar = collectInventory(generatedPages);

  const alleSchluessel = new Set([...referenzInventar.keys(), ...generiertInventar.keys()]);
  const inventory = [...alleSchluessel]
    .map((key) => {
      const referenz = referenzInventar.get(key) ?? null;
      const generiert = generiertInventar.get(key) ?? null;
      const style = (referenz ?? generiert).style;

      let status = 'equal';
      if (!referenz) status = 'only-generated';
      else if (!generiert) status = 'only-reference';
      else if (referenz.words !== generiert.words) status = 'count-differs';

      return {
        key,
        style,
        description: describeStyle(style),
        status,
        reference: referenz ? { words: referenz.words, pages: [...referenz.pages].sort((a, b) => a - b) } : null,
        generated: generiert ? { words: generiert.words, pages: [...generiert.pages].sort((a, b) => a - b) } : null,
      };
    })
    .sort((a, b) => {
      // Auffälligkeiten zuerst, danach nach Schriftgröße absteigend.
      const gewicht = (row) => (row.status === 'equal' ? 1 : 0);
      return gewicht(a) - gewicht(b) || b.style.size - a.style.size || a.description.localeCompare(b.description);
    });

  // ------------------------------------------------------------ Abweichungen
  const rohe = [];
  const seitenAnzahl = Math.min(referencePages.length, generatedPages.length);

  for (let index = 0; index < seitenAnzahl; index += 1) {
    const referenzSeite = referencePages[index];
    const generierteSeite = generatedPages[index];
    const referenzWoerter = referenzSeite.words ?? [];
    const generierteWoerter = generierteSeite.words ?? [];

    // Nur inhaltlich übereinstimmende Wörter vergleichen – sonst wäre nicht
    // unterscheidbar, ob sich der Text oder nur die Formatierung geändert hat.
    const ops = diffTokens(
      referenzWoerter.map((w) => w.text),
      generierteWoerter.map((w) => w.text)
    );

    for (const op of ops) {
      if (op.type !== 'equal') continue;
      const referenzWort = referenzWoerter[op.aIndex];
      const generiertesWort = generierteWoerter[op.bIndex];
      if (!referenzWort?.style || !generiertesWort?.style) continue;

      const unterschiede = describeDifferences(referenzWort.style, generiertesWort.style);
      if (unterschiede.length === 0) continue;

      rohe.push({
        pageNumber: referenzSeite.pageNumber,
        text: referenzWort.text,
        wordIndex: op.bIndex,
        differences: unterschiede,
        reference: referenzWort.style,
        generated: generiertesWort.style,
        referenceDescription: describeStyle(referenzWort.style),
        generatedDescription: describeStyle(generiertesWort.style),
        box: generiertesWort.box,
      });
    }
  }

  const deviations = mergeAdjacent(rohe);
  const betroffeneSeiten = [...new Set(deviations.map((d) => d.pageNumber))].sort((a, b) => a - b);

  const artenZaehlen = (art) => deviations.filter((d) => d.differences.includes(art)).length;

  return {
    identical: deviations.length === 0 && inventory.every((row) => row.status === 'equal'),
    colorsResolved,
    inventory,
    spacing: compareSpacing(referencePages, generatedPages),
    deviations,
    totals: {
      deviations: deviations.length,
      affectedWords: deviations.reduce((sum, d) => sum + d.words, 0),
      affectedPages: betroffeneSeiten,
      byKind: {
        Schriftart: artenZaehlen('Schriftart'),
        'Schriftgröße': artenZaehlen('Schriftgröße'),
        Fettung: artenZaehlen('Fettung'),
        Kursivstellung: artenZaehlen('Kursivstellung'),
        Textfarbe: artenZaehlen('Textfarbe'),
      },
      fontsOnlyInReference: inventory.filter((row) => row.status === 'only-reference').length,
      fontsOnlyInGenerated: inventory.filter((row) => row.status === 'only-generated').length,
    },
  };
}
