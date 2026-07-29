/**
 * Baut minimale PDFs mit handgeschriebenem Inhaltsstrom.
 * Nötig, um Fälle zu erzeugen, die Bibliotheken wie pdfkit nicht abbilden –
 * etwa ein Sonderzeichen, das aus einer anderen Schrift gesetzt wird und
 * dadurch als eigenes Textelement im PDF landet.
 */
function buildPdf(content, { zweiSchriften = false } = {}) {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  const fonts = zweiSchriften ? '/F1 5 0 R /F2 6 0 R' : '/F1 5 0 R';
  objs[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
    `/Resources << /Font << ${fonts} >> >> /Contents 4 0 R >>`;
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>';

  const anzahl = zweiSchriften ? 6 : 5;
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
