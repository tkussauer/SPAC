/**
 * Baut minimale PDFs mit handgeschriebenem Inhaltsstrom.
 * Nötig, um Fälle zu erzeugen, die Bibliotheken wie pdfkit nicht abbilden –
 * etwa ein Sonderzeichen, das aus einer anderen Schrift gesetzt wird und
 * dadurch als eigenes Textelement im PDF landet.
 */
function buildPdf(
  content,
  { zweiSchriften = false, mitSymbolschrift = false, mitTransparenz = false, mitMarkierungsschrift = false } = {}
) {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  const schriften = ['/F1 5 0 R'];
  if (zweiSchriften) schriften.push('/F2 6 0 R');
  if (mitSymbolschrift) schriften.push('/F3 7 0 R');
  if (mitMarkierungsschrift) schriften.push('/F4 9 0 R');
  const fonts = schriften.join(' ');
  objs[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
    `/Resources << /Font << ${fonts} >> ${mitTransparenz ? '/ExtGState << /GS0 8 0 R >>' : ''} >> /Contents 4 0 R >>`;
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>';

  objs[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>';
  objs[8] = '<< /Type /ExtGState /ca 0 >>';
  // Schrift mit nichtssagendem Subset-Namen: über den Namen ist sie nicht als Symbolschrift
  // zu erkennen – genau der Fall, den echte Formulargeneratoren erzeugen.
  objs[9] = '<< /Type /Font /Subtype /Type1 /BaseFont /AAAAAA+F2 /Encoding /WinAnsiEncoding >>';
  const anzahl = mitMarkierungsschrift ? 9 : mitTransparenz ? 8 : mitSymbolschrift ? 7 : zweiSchriften ? 6 : 5;
  return assemble(objs, anzahl);
}

/** Setzt die Objekte 1..anzahl zu einem PDF mit gueltiger Querverweistabelle zusammen. */
function assemble(objs, anzahl) {
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i <= anzahl; i += 1) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${anzahl + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= anzahl; i += 1) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${anzahl + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Escapes für Zeichenketten im PDF-Inhaltsstrom. */
const esc = (text) => text.replace(/[\\()]/g, (z) => `\\${z}`);

/** PDF mit je einer Zeile Text, alles in einer Schrift. */
export function makeSimplePdf(zeilen) {
  const teile = ['BT /F1 12 Tf 50 780 Td'];
  zeilen.forEach((zeile, index) => {
    if (index > 0) teile.push('0 -16 Td');
    teile.push(`(${esc(zeile)}) Tj`);
  });
  teile.push('ET');
  return buildPdf(teile.join(' '));
}

/**
 * Wie makeSimplePdf, aber "ä" wird aus einer zweiten Schrift gesetzt und landet
 * dadurch als eigenes Textelement im PDF – der Fall, bei dem aus
 * "Selbstständige(r)" ohne Zusammenführung "Selbstst ä ndige(r)" würde.
 */
export function makeSplitCharPdf() {
  const content =
    'BT /F1 12 Tf 50 780 Td (Selbstst) Tj /F2 12 Tf (\\344) Tj /F1 12 Tf (ndige\\(r\\)/Freiberufler\\(in\\)) Tj ' +
    '0 -16 Td (Betrag 100 EUR) Tj ET';
  return buildPdf(content, { zweiSchriften: true });
}

/** PDF mit frei vorgegebenem Inhaltsstrom (zwei Schriften verfügbar: /F1, /F2). */
export function makeRawTextPdf(content) {
  return buildPdf(content, { zweiSchriften: true });
}

/**
 * PDF mit Checkbox-Kästchen aus einer Symbolschrift (ZapfDingbats). Die Zeichen haben
 * keine Unicode-Zuordnung; die Textextraktion liefert dafür den rohen Zeichencode – aus
 * dem Kästchen wird ein "A". Genau so entstehen Zeilen wie
 * "A einmalig A gelegentlich A bis zu einer Woche".
 */
export function makeCheckboxPdf(optionen, { mitKaestchen = true } = {}) {
  const teile = ['BT 50 780 Td'];
  optionen.forEach((option, index) => {
    if (index > 0) teile.push('/F1 12 Tf ( ) Tj');
    if (mitKaestchen) teile.push('/F3 12 Tf (A) Tj /F1 12 Tf ( ) Tj');
    teile.push(`/F1 12 Tf (${esc(option)}) Tj`);
  });
  teile.push('ET');
  return buildPdf(teile.join(' '), { mitSymbolschrift: true });
}

/**
 * Wie makeCheckboxPdf, zeichnet die Kästchen aber in einem eigenen Durchgang – erst alle
 * Kästchen, dann alle Beschriftungen. Genau so arbeiten viele Formulargeneratoren, wodurch
 * die Zeichenreihenfolge im PDF nicht der Lesereihenfolge entspricht.
 */
export function makeCheckboxPdfSeparatePass(optionen) {
  const teile = [];
  let x = 50;
  const positionen = [];
  for (const option of optionen) {
    positionen.push({ option, x });
    x += 12 + option.length * 6.7 + 8;
  }

  // 1. Durchgang: nur die Kästchen
  for (const { x: px } of positionen) {
    teile.push(`BT /F3 12 Tf ${px} 780 Td (A) Tj ET`);
  }
  // 2. Durchgang: nur die Beschriftungen
  for (const { option, x: px } of positionen) {
    teile.push(`BT /F1 12 Tf ${px + 12} 780 Td (${esc(option)}) Tj ET`);
  }
  return buildPdf(teile.join(' '), { mitSymbolschrift: true });
}

/**
 * Wie makeCheckboxPdf, aber die Kästchen kommen aus einer Schrift mit **nichtssagendem
 * Namen** ("AAAAAA+F2"). Weder der Schriftname noch der gezeichnete Glyph verraten hier eine
 * Symbolschrift – erkennbar ist sie nur daran, dass sie ausschließlich einzelne, sich
 * wiederholende Zeichen setzt. Genau so liefern echte Formulargeneratoren ihre Kästchen.
 */
export function makeMarkerFontPdf(optionen, { mitMarken = true } = {}) {
  const teile = ['BT 50 780 Td'];
  optionen.forEach((option, index) => {
    if (index > 0) teile.push('/F1 12 Tf ( ) Tj');
    if (mitMarken) teile.push('/F4 12 Tf (A) Tj /F1 12 Tf ( ) Tj');
    teile.push(`/F1 12 Tf (${esc(option)}) Tj`);
  });
  teile.push('ET');
  return buildPdf(teile.join(' '), { mitMarkierungsschrift: true });
}

/** Dieselben Zeilen, aber in umgekehrter Zeichenreihenfolge ausgegeben. */
export function makeReversedOrderPdf(zeilen) {
  const teile = [];
  [...zeilen].reverse().forEach((zeile, index) => {
    const y = 780 - (zeilen.length - 1 - index) * 16;
    teile.push(`BT /F1 12 Tf 50 ${y} Td (${esc(zeile)}) Tj ET`);
  });
  return buildPdf(teile.join(' '));
}

/**
 * PDF mit nicht sichtbaren Inhalten. `varianten` wählt aus:
 *  - 'renderMode'  : Text mit Rendermodus 3 (wird nicht gezeichnet, z. B. OCR-Ebene)
 *  - 'alpha'       : Text mit Fülldeckkraft 0
 *  - 'nullGroesse' : Text mit Schriftgröße 0
 *  - 'ausserhalb'  : Text außerhalb des Seitenbereichs
 */
export function makeInvisibleTextPdf(sichtbareZeilen, varianten = []) {
  const teile = [];
  sichtbareZeilen.forEach((zeile, index) => {
    teile.push(`BT /F1 12 Tf 50 ${780 - index * 16} Td (${esc(zeile)}) Tj ET`);
  });

  if (varianten.includes('renderMode')) {
    teile.push('q BT /F1 12 Tf 3 Tr 50 700 Td (UnsichtbarerRenderModus) Tj ET Q');
  }
  if (varianten.includes('alpha')) {
    teile.push('q /GS0 gs BT /F1 12 Tf 50 680 Td (UnsichtbareDeckkraft) Tj ET Q');
  }
  if (varianten.includes('nullGroesse')) {
    teile.push('q BT /F1 0 Tf 50 660 Td (Nullgroesse) Tj ET Q');
  }
  if (varianten.includes('ausserhalb')) {
    teile.push('q BT /F1 12 Tf 50 -400 Td (AusserhalbDerSeite) Tj ET Q');
  }

  return buildPdf(teile.join(' '), { mitTransparenz: true });
}

/**
 * PDF mit frei platzierten Textzeilen. Jedes Element: { text, x?, y } mit y in
 * PDF-Koordinaten (Ursprung unten links). Nützlich, um Kopf-/Fußzeilenbereiche gezielt
 * zu treffen. Standardseite ist A4 (595 × 842 pt).
 */
export function makePositionedPdf(elemente) {
  const teile = elemente.map(
    ({ text, x = 50, y }) => `BT /F1 12 Tf ${x} ${y} Td (${esc(text)}) Tj ET`
  );
  return buildPdf(teile.join(' '));
}

/**
 * PDF mit horizontalem Fließtext und zusätzlich vertikal (90°) gesetztem Text am Rand –
 * etwa ein Aktenzeichen oder Stempel. `vertikaleTexte` wird über eine gedrehte Textmatrix
 * (Tm) gesetzt und landet dadurch als vertikaler Text im PDF.
 */
export function makeVerticalMarginPdf(horizontaleZeilen, vertikaleTexte = []) {
  const teile = horizontaleZeilen.map(
    (zeile, i) => `BT /F1 12 Tf 50 ${780 - i * 16} Td (${esc(zeile)}) Tj ET`
  );
  vertikaleTexte.forEach((text, i) => {
    // [0 1 -1 0 x y]: 90° gegen den Uhrzeigersinn, am linken Rand
    teile.push(`BT /F1 12 Tf 0 1 -1 0 ${25 + i * 14} 300 Tm (${esc(text)}) Tj ET`);
  });
  return buildPdf(teile.join(' '));
}

/**
 * PDF mit **eingebetteter** Schrift (Subset). In echten PDFs der Normalfall – und der Grund,
 * warum die Glyph-Erkennung eng gefasst sein muss: Subset-Schriften bilden ganz normale
 * Buchstaben in den Private-Use-Bereich ab, sähen also wie Symbole aus.
 */
export async function makeEmbeddedFontPdf(zeilen, schrift = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf') {
  const { default: PDFDocument } = await import('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.font(schrift).fontSize(12);
    for (const zeile of zeilen) doc.text(zeile);
    doc.end();
  });
}

/**
 * PDF mit **Formularfeldern** (AcroForm). Der eingetragene Wert steht im Feld selbst (`/V`)
 * und wird über einen eigenen Erscheinungsstrom (`/AP`) gezeichnet – er ist **nicht** Teil des
 * Seiteninhalts. Die normale Textextraktion sieht davon nichts.
 *
 * `felder`: [{ label, value, y, mitAppearance? }]
 * `varianten`:
 *  - 'ohneAppearance' : Werte ohne Erscheinungsstrom (der Betrachter muss ihn erzeugen –
 *                       genau das tut sonst nur der Acrobat Reader)
 *  - 'needAppearances': zusätzlich das Kennzeichen /NeedAppearances im AcroForm
 *  - 'versteckt'      : Feld mit gesetztem Hidden-Flag
 */
export function makeFormFieldPdf(felder, varianten = []) {
  const ohneAppearance = varianten.includes('ohneAppearance');
  const versteckt = varianten.includes('versteckt');
  const objs = [];

  // Beschriftungen stehen im Seiteninhalt, die Werte ausschliesslich in den Feldern.
  const content = felder
    .map(({ label, y }) => `BT /F1 12 Tf 50 ${y} Td (${esc(label)}) Tj ET`)
    .join(' ');

  const ersteFeldNummer = 6;
  const feldNummern = felder.map((_, i) => ersteFeldNummer + i * 2);
  objs[1 + 0] =
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${feldNummern
      .map((n) => `${n} 0 R`)
      .join(' ')}] ${varianten.includes('needAppearances') ? '/NeedAppearances true ' : ''}` +
    `/DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>`;
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> ` +
    `/Contents 4 0 R /Annots [${feldNummern.map((n) => `${n} 0 R`).join(' ')}] >>`;
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  felder.forEach(({ value, y }, index) => {
    const feld = feldNummern[index];
    const ap = feld + 1;
    const rect = `[200 ${y - 3} 460 ${y + 13}]`;
    // Flags: 4 = Print, 2 = Hidden
    objs[feld] =
      `<< /Type /Annot /Subtype /Widget /FT /Tx /T (feld${index}) /V (${esc(value)}) ` +
      `/Rect ${rect} /F ${versteckt ? 2 : 4} /DA (/Helv 10 Tf 0 g) ` +
      `${ohneAppearance ? '' : `/AP << /N ${ap} 0 R >> `}>>`;

    const strom = `/Tx BMC q BT /Helv 10 Tf 0 g 2 4 Td (${esc(value)}) Tj ET Q EMC`;
    objs[ap] =
      `<< /Type /XObject /Subtype /Form /BBox [0 0 260 16] ` +
      `/Resources << /Font << /Helv 5 0 R >> >> /Length ${strom.length} >>\nstream\n${strom}\nendstream`;
  });

  return assemble(objs, ersteFeldNummer + felder.length * 2 - 1);
}
