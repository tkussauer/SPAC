/**
 * Vergleicht zwei HTTP-Requests – den, den die Anwendung senden würde, mit einem
 * aufgezeichneten Fremd-Request (z. B. aus Postman). Zweck: den Unterschied finden,
 * wenn derselbe Aufruf mit einem anderen Werkzeug funktioniert.
 */

/** Header, die der HTTP-Client bzw. der Server automatisch setzt. */
const AUTOMATISCH = new Set(['host', 'content-length', 'connection']);
/** Header, die Postman & Co. eigenmächtig ergänzen und für den Zielservice selten relevant sind. */
const WERKZEUG_EIGEN = new Set(['postman-token', 'accept-encoding', 'cache-control', 'cookie']);

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Zählt Zeilenenden und erkennt gemischte Schreibweisen. */
export function analyseLineEndings(buffer) {
  const text = buffer.toString('latin1');
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(^|[^\r])\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;

  let art = 'keine';
  if (crlf > 0 && lf === 0 && cr === 0) art = 'CRLF';
  else if (lf > 0 && crlf === 0 && cr === 0) art = 'LF';
  else if (crlf > 0 || lf > 0 || cr > 0) art = 'gemischt';

  return { art, crlf, lf, cr };
}

/** Findet die erste abweichende Byte-Position zweier Buffer. */
export function firstDifference(a, b) {
  const laenge = Math.min(a.length, b.length);
  for (let index = 0; index < laenge; index += 1) {
    if (a[index] !== b[index]) return index;
  }
  return a.length === b.length ? -1 : laenge;
}

/** Zeigt die Umgebung einer Byte-Position lesbar an. */
function context(buffer, position, umgebung = 24) {
  const von = Math.max(0, position - umgebung);
  const bis = Math.min(buffer.length, position + umgebung);
  const ausschnitt = buffer.subarray(von, bis);
  return {
    offset: von,
    text: ausschnitt.toString('utf8').replace(/\r/g, '\\r').replace(/\n/g, '\\n'),
    hex: [...ausschnitt].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    byte: position < buffer.length ? `0x${buffer[position].toString(16).padStart(2, '0')}` : '(Ende)',
  };
}

/** Vergleicht die Header beider Requests. */
export function compareHeaders(eigene, fremde) {
  const normalisieren = (headers) => {
    const map = new Map();
    for (const [name, wert] of Object.entries(headers ?? {})) {
      map.set(name.toLowerCase(), { name, value: Array.isArray(wert) ? wert.join(', ') : String(wert) });
    }
    return map;
  };

  const meine = normalisieren(eigene);
  const ihre = normalisieren(fremde);
  const alle = [...new Set([...meine.keys(), ...ihre.keys()])].sort();

  return alle.map((schluessel) => {
    const links = meine.get(schluessel) ?? null;
    const rechts = ihre.get(schluessel) ?? null;

    let status;
    if (links && rechts) status = links.value === rechts.value ? 'gleich' : 'unterschiedlich';
    else if (rechts) status = 'nur-aufgezeichnet';
    else status = 'nur-anwendung';

    return {
      name: (rechts ?? links).name,
      key: schluessel,
      application: links?.value ?? null,
      captured: rechts?.value ?? null,
      status,
      automatic: AUTOMATISCH.has(schluessel),
      toolSpecific: WERKZEUG_EIGEN.has(schluessel),
      // Für die Übernahme in "Zusätzliche Header" relevant?
      adoptable: status !== 'gleich' && !AUTOMATISCH.has(schluessel) && !WERKZEUG_EIGEN.has(schluessel),
    };
  });
}

/** Vergleicht die Bodys beider Requests auf Byte-Ebene. */
export function compareBodies(eigener, fremder) {
  const a = Buffer.from(eigener ?? []);
  const b = Buffer.from(fremder ?? []);
  const position = firstDifference(a, b);
  const identisch = position === -1;

  return {
    identical: identisch,
    applicationBytes: a.length,
    capturedBytes: b.length,
    firstDifferenceAt: identisch ? null : position,
    applicationContext: identisch ? null : context(a, position),
    capturedContext: identisch ? null : context(b, position),
    lineEndings: {
      application: analyseLineEndings(a),
      captured: analyseLineEndings(b),
    },
    bom: {
      application: a.subarray(0, 3).equals(BOM),
      captured: b.subarray(0, 3).equals(BOM),
    },
    trailingNewline: {
      application: a.length > 0 && (a[a.length - 1] === 0x0a || a[a.length - 1] === 0x0d),
      captured: b.length > 0 && (b[b.length - 1] === 0x0a || b[b.length - 1] === 0x0d),
    },
    validUtf8: {
      application: Buffer.from(a.toString('utf8'), 'utf8').equals(a),
      captured: Buffer.from(b.toString('utf8'), 'utf8').equals(b),
    },
  };
}

/** Formuliert die gefundenen Unterschiede als verständliche Hinweise. */
export function summarise(headers, body, methodDiffers, pathDiffers) {
  const hinweise = [];

  if (methodDiffers) hinweise.push('Die HTTP-Methode unterscheidet sich.');
  if (pathDiffers) hinweise.push('Der aufgerufene Pfad unterscheidet sich.');

  const fehlend = headers.filter((h) => h.status === 'nur-aufgezeichnet' && !h.automatic && !h.toolSpecific);
  for (const header of fehlend) {
    hinweise.push(`Der Header "${header.name}: ${header.captured}" fehlt in der Anwendung.`);
  }

  const abweichend = headers.filter((h) => h.status === 'unterschiedlich' && !h.automatic);
  for (const header of abweichend) {
    hinweise.push(
      `Der Header "${header.name}" unterscheidet sich: Anwendung "${header.application}", aufgezeichnet "${header.captured}".`
    );
  }

  const zusaetzlich = headers.filter((h) => h.status === 'nur-anwendung' && !h.automatic);
  for (const header of zusaetzlich) {
    hinweise.push(`Die Anwendung sendet zusätzlich "${header.name}: ${header.application}".`);
  }

  if (!body.identical) {
    if (body.applicationBytes !== body.capturedBytes) {
      hinweise.push(
        `Die Bodys sind unterschiedlich lang: Anwendung ${body.applicationBytes} Bytes, aufgezeichnet ${body.capturedBytes} Bytes.`
      );
    }
    if (body.lineEndings.application.art !== body.lineEndings.captured.art) {
      hinweise.push(
        `Die Zeilenenden unterscheiden sich: Anwendung ${body.lineEndings.application.art}, aufgezeichnet ${body.lineEndings.captured.art}.`
      );
    }
    if (body.bom.application !== body.bom.captured) {
      hinweise.push(
        body.bom.captured
          ? 'Der aufgezeichnete Body beginnt mit einem BOM, der der Anwendung nicht.'
          : 'Der Body der Anwendung beginnt mit einem BOM, der aufgezeichnete nicht.'
      );
    }
    if (body.trailingNewline.application !== body.trailingNewline.captured) {
      hinweise.push(
        body.trailingNewline.captured
          ? 'Der aufgezeichnete Body endet mit einem Zeilenumbruch, der der Anwendung nicht.'
          : 'Der Body der Anwendung endet mit einem Zeilenumbruch, der aufgezeichnete nicht.'
      );
    }
    if (body.firstDifferenceAt !== null) {
      hinweise.push(`Erste Abweichung im Body an Byte ${body.firstDifferenceAt}.`);
    }
  }

  if (hinweise.length === 0) {
    hinweise.push('Kein Unterschied gefunden – beide Anfragen sind identisch.');
  }
  return hinweise;
}

/**
 * @param {{method:string, path:string, headers:object, bodyBuffer:Buffer}} application
 * @param {{method:string, path:string, headers:object, bodyBuffer:Buffer}} captured
 */
export function compareRequests(application, captured) {
  const headers = compareHeaders(application.headers, captured.headers);
  const body = compareBodies(application.bodyBuffer, captured.bodyBuffer);
  const methodDiffers = (application.method ?? 'POST') !== (captured.method ?? 'POST');
  const pathDiffers = Boolean(application.path && captured.path && application.path !== captured.path);

  return {
    identical: body.identical && headers.every((h) => h.status === 'gleich' || h.automatic || h.toolSpecific),
    method: { application: application.method ?? 'POST', captured: captured.method ?? 'POST', differs: methodDiffers },
    path: { application: application.path ?? null, captured: captured.path ?? null, differs: pathDiffers },
    headers,
    body,
    hints: summarise(headers, body, methodDiffers, pathDiffers),
    /** Vorschlag für das Feld „Zusätzliche Header“. */
    suggestedHeaders: headers
      .filter((h) => h.adoptable && h.captured !== null && h.key !== 'content-type')
      .map((h) => `${h.name}: ${h.captured}`)
      .join('\n'),
    suggestedContentType: headers.find((h) => h.key === 'content-type' && h.status !== 'gleich')?.captured ?? null,
  };
}
