/**
 * Liest Feldwerte aus dem **XFA-Teil** eines PDFs.
 *
 * Manche Formulargeneratoren (etwa Quadient Inspire) legen ein Hybrid-Formular an: Die
 * AcroForm-Felder bleiben leer, es gibt keine Erscheinungsströme – der eingetragene Wert steht
 * ausschließlich im XFA-Template als `<field name="…"><value><text>…</text></value>`. Erst der
 * Acrobat Reader baut daraus die sichtbare Seite auf; jeder andere Betrachter zeigt an dieser
 * Stelle nichts an, und auch die Textextraktion findet nichts.
 *
 * Der XFA-Teil ist XML. Er wird hier bewusst mit Mustern ausgewertet statt mit einem
 * XML-Parser: Es geht um genau zwei Angaben je Feld (Name und Textwert), und die Anwendung
 * soll ohne zusätzliche Abhängigkeit auskommen.
 */
import zlib from 'node:zlib';

/** Obergrenze je Datenstrom (entpackt), damit ein defektes PDF nicht den Speicher sprengt. */
const MAX_STROM = 32 * 1024 * 1024;

/** Kennzeichen, an denen ein XFA-Datenstrom zu erkennen ist. */
const XFA_KENNZEICHEN = /<(xdp:xdp|template|xfa:datasets|xfa:data)[\s>]/;

/**
 * Sucht die XFA-XML-Datenströme in einem PDF.
 *
 * Statt die Referenz aus dem AcroForm-Wörterbuch aufzulösen, werden alle Datenströme
 * durchgesehen und die als XFA erkannten zurückgegeben. Das ist unempfindlich dagegen, wie das
 * PDF seine Objekte ablegt (auch bei komprimierten Objektströmen), und der XFA-Teil selbst ist
 * immer ein eigener Datenstrom.
 */
export function findXfaStreams(buffer) {
  const roh = buffer.toString('latin1');
  if (!roh.includes('/XFA')) return [];

  const gefunden = [];
  const streamRe = /stream\r?\n/g;
  let treffer;

  while ((treffer = streamRe.exec(roh)) !== null) {
    const start = treffer.index + treffer[0].length;
    const ende = roh.indexOf('endstream', start);
    if (ende === -1) continue;
    // Hinter das Schlüsselwort springen: "endstream" enthält selbst "stream" und würde sonst
    // als Anfang des nächsten Datenstroms gelesen – der echte nächste Anfang wäre übersprungen.
    streamRe.lastIndex = ende + 'endstream'.length;

    const daten = buffer.subarray(start, ende);
    if (daten.length === 0 || daten.length > MAX_STROM) continue;

    // Erst entpacken versuchen, dann unverändert lesen. Die Reihenfolge ist wichtig: Ob ein
    // Datenstrom komprimiert ist, lässt sich am Inhalt nicht zuverlässig ablesen – gepackte
    // Daten enthalten regelmäßig Bytes, die wie Textzeichen aussehen.
    let text = null;
    try {
      const entpackt = zlib.inflateSync(daten);
      if (entpackt.length <= MAX_STROM) text = entpackt.toString('utf8');
    } catch {
      text = daten.toString('utf8');
    }

    // Der Zeilenumbruch vor "endstream" gehört zur PDF-Syntax, nicht zu den Daten.
    if (text && XFA_KENNZEICHEN.test(text)) gefunden.push(text.replace(/\r?\n$/, ''));
  }

  return gefunden;
}

/** Wandelt XML-Entitäten in Zeichen zurück. */
function entschluessele(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dez) => String.fromCodePoint(Number(dez)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Entfernt Auszeichnungen aus einem Rich-Text-Wert und fasst Leerraum zusammen. */
function nurText(inhalt) {
  return entschluessele(inhalt.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Liest die Feldwerte aus einem oder mehreren XFA-XML-Texten.
 *
 * Kommt ein Feldname mit **unterschiedlichen** Werten mehrfach vor, ist die Zuordnung nicht
 * eindeutig – dann wird er verworfen, statt zu raten.
 *
 * @returns {Map<string, string>} Feldname -> Textwert
 */
export function parseXfaFieldValues(xmlTexte) {
  const werte = new Map();
  const mehrdeutig = new Set();

  for (const xml of xmlTexte) {
    const feldRe = /<field\s+[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/field>/g;
    let feld;
    while ((feld = feldRe.exec(xml)) !== null) {
      const name = entschluessele(feld[1]);
      const wert = feld[2].match(/<value>[\s\S]*?<text(?:\s[^>]*)?>([\s\S]*?)<\/text>[\s\S]*?<\/value>/);
      if (!wert) continue;

      const text = nurText(wert[1]);
      if (text === '') continue;

      if (werte.has(name) && werte.get(name) !== text) {
        mehrdeutig.add(name);
        continue;
      }
      werte.set(name, text);
    }
  }

  for (const name of mehrdeutig) werte.delete(name);
  return werte;
}

/**
 * Der Name, unter dem ein AcroForm-Feld im XFA-Teil zu finden ist.
 *
 * AcroForm-Felder tragen den vollen Pfad samt Wiederholungsindex
 * ("GMCForm…[0].BusinessData_nameTitelBezug[0]"), das XFA-Template nur den Namen selbst.
 */
export function xfaLookupName(fieldName) {
  if (typeof fieldName !== 'string' || fieldName === '') return null;
  const letztes = fieldName.split('.').pop();
  return letztes.replace(/\[\d+\]$/, '') || null;
}

/** Bequemer Einstieg: PDF-Puffer rein, Feldname -> Wert raus. */
export function xfaFieldValues(buffer) {
  try {
    const stroeme = findXfaStreams(buffer);
    return stroeme.length === 0 ? new Map() : parseXfaFieldValues(stroeme);
  } catch {
    // Der XFA-Teil ist eine Zusatzquelle – ein Fehler darf die Extraktion nie stoppen.
    return new Map();
  }
}
