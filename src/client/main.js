import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

const STORAGE_KEY = 'spac.pdfcompare.settings.v1';
/** Mindestbreite einer gezeichneten Seite, falls das Layout noch keine Breite liefert. */
const MIN_PAGE_WIDTH = 280;
/** Obergrenze für die Bitmap-Auflösung (begrenzt den Speicherbedarf). */
const MAX_PIXEL_RATIO = 2;
/** Wartezeit, bevor nach einer Fenstergrößenänderung neu gezeichnet wird. */
const RESIZE_DELAY_MS = 250;

const el = (id) => document.getElementById(id);

const dom = {
  form: el('compare-form'),
  xmlFile: el('xml-file'),
  referenceFile: el('reference-file'),
  targetUrl: el('target-url'),
  templatePath: el('template-path'),
  contentType: el('content-type'),
  extraHeaders: el('extra-headers'),
  lineEnding: el('line-ending'),
  ignoreSymbols: el('ignore-symbols'),
  ignoreInvisible: el('ignore-invisible'),
  advanced: el('advanced'),
  tabs: el('tabs'),
  tabPdf: el('tab-pdf'),
  tabMarkdown: el('tab-markdown'),
  tabStyle: el('tab-style'),
  stylePanel: el('style-panel'),
  styleSummary: el('style-summary'),
  styleColorHint: el('style-color-hint'),
  styleDeviations: el('style-deviations'),
  styleInventory: el('style-inventory'),
  markdownPanel: el('markdown-panel'),
  markdownRows: el('markdown-rows'),
  markdownSummary: el('markdown-summary'),
  markdownDownload: el('markdown-download'),
  toggleOnlyDiff: el('toggle-only-diff'),
  viewControls: el('view-controls'),
  toggleHighlights: el('toggle-highlights'),
  diagnostics: el('diagnostics'),
  diagnosticsContent: el('diagnostics-content'),
  captureUrl: el('capture-url'),
  captureCopy: el('capture-copy'),
  captureCompare: el('capture-compare'),
  captureReset: el('capture-reset'),
  captureStatus: el('capture-status'),
  captureResult: el('capture-result'),
  captureHints: el('capture-hints'),
  captureHeaders: el('capture-headers'),
  captureBody: el('capture-body'),
  captureAdopt: el('capture-adopt'),
  captureApply: el('capture-apply'),
  generateButton: el('generate-button'),
  refreshButton: el('refresh-button'),
  downloadLink: el('download-link'),
  status: el('status'),
  errorBox: el('error-box'),
  errorMessage: el('error-message'),
  errorDetails: el('error-details'),
  summary: el('summary'),
  summaryStatus: el('summary-status'),
  summaryPages: el('summary-pages'),
  summaryDiffPages: el('summary-diff-pages'),
  summaryWords: el('summary-words'),
  summaryDuration: el('summary-duration'),
  summarySymbols: el('summary-symbols'),
  viewer: el('viewer'),
};

/** Zustand, der zwischen "Generieren" und "Refresh" erhalten bleibt (FR7, NFR3). */
const state = {
  xmlContent: null,
  xmlFileName: null,
  referenceId: null,
  referenceFileName: null,
  busy: false,
  /** Zeichenaufträge der aktuellen Ansicht – für das Neuzeichnen nach Größenänderung. */
  renderJobs: [],
  /** Markdown-Fassung und Zeilenvergleich des letzten Laufs. */
  markdown: null,
  /** Font- und Stilvergleich des letzten Laufs. */
  style: null,
  /** Aktiver Reiter: 'pdf', 'markdown' oder 'style'. */
  activeTab: 'pdf',
};

// ---------------------------------------------------------------- Persistenz

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (typeof saved.targetUrl === 'string') dom.targetUrl.value = saved.targetUrl;
    if (typeof saved.templatePath === 'string') dom.templatePath.value = saved.templatePath;
    if (typeof saved.contentType === 'string' && saved.contentType.trim()) {
      dom.contentType.value = saved.contentType;
      if (saved.contentType !== dom.contentType.defaultValue) dom.advanced?.setAttribute('open', '');
    }
    if (saved.lineEnding === 'lf' || saved.lineEnding === 'crlf' || saved.lineEnding === 'keep') {
      dom.lineEnding.value = saved.lineEnding;
      if (saved.lineEnding !== 'lf') dom.advanced?.setAttribute('open', '');
    }
    if (typeof saved.extraHeaders === 'string' && saved.extraHeaders.trim()) {
      dom.extraHeaders.value = saved.extraHeaders;
      dom.advanced?.setAttribute('open', '');
    }
    if (typeof saved.ignoreInvisible === 'boolean') {
      dom.ignoreInvisible.checked = saved.ignoreInvisible;
      if (!saved.ignoreInvisible) dom.advanced?.setAttribute('open', '');
    }
    if (typeof saved.ignoreSymbols === 'boolean') {
      dom.ignoreSymbols.checked = saved.ignoreSymbols;
      if (!saved.ignoreSymbols) dom.advanced?.setAttribute('open', '');
    }
    if (typeof saved.showHighlights === 'boolean') dom.toggleHighlights.checked = saved.showHighlights;
    if (typeof saved.onlyDiffLines === 'boolean') dom.toggleOnlyDiff.checked = saved.onlyDiffLines;
    if (TABS.includes(saved.activeTab)) state.activeTab = saved.activeTab;
  } catch {
    /* Einstellungen sind optional – Fehler hier dürfen die App nicht blockieren. */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        targetUrl: dom.targetUrl.value,
        templatePath: dom.templatePath.value,
        contentType: dom.contentType.value,
        extraHeaders: dom.extraHeaders.value,
        lineEnding: dom.lineEnding.value,
        ignoreSymbols: dom.ignoreSymbols.checked,
        ignoreInvisible: dom.ignoreInvisible.checked,
        showHighlights: dom.toggleHighlights.checked,
        onlyDiffLines: dom.toggleOnlyDiff.checked,
        activeTab: state.activeTab,
      })
    );
  } catch {
    /* z. B. privater Modus – ignorierbar */
  }
}

// ------------------------------------------------------------------- UI-Hilfen

function setStatus(text) {
  dom.status.textContent = text || '';
}

function showError(message, details, logFile = null) {
  dom.errorMessage.textContent = logFile ? `${message}\n\nVollständiges Protokoll: ${logFile}` : message;

  // Bei Fehlern des Zielservice den gesendeten Body und die Antwort mit anzeigen.
  if (details?.request) {
    renderExchange(details.request, details.response);
    dom.errorDetails.hidden = true;
  } else if (details) {
    dom.errorDetails.textContent = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
    dom.errorDetails.hidden = false;
  } else {
    dom.errorDetails.hidden = true;
  }
  dom.errorBox.hidden = false;
}

function clearError() {
  dom.errorBox.hidden = true;
  dom.errorDetails.hidden = true;
  dom.errorMessage.textContent = '';
}

function setBusy(busy) {
  state.busy = busy;
  dom.generateButton.disabled = busy;
  dom.refreshButton.disabled = busy || !canRefresh();
}

function canRefresh() {
  return Boolean(state.xmlContent && dom.targetUrl.value.trim() && dom.templatePath.value.trim());
}

async function readErrorFromResponse(response) {
  try {
    const data = await response.json();
    if (data?.error?.message) {
      return {
        message: data.error.message,
        details: data.error.details ?? null,
        logFile: data.error.logFile ?? null,
      };
    }
  } catch {
    /* keine JSON-Antwort */
  }
  return { message: `Serverfehler (HTTP ${response.status}).`, details: null, logFile: null };
}

// ------------------------------------------------------------------ Dateien

async function handleXmlFile(file) {
  if (!file) {
    state.xmlContent = null;
    state.xmlFileName = null;
    return;
  }
  if (!/\.xml$/i.test(file.name)) {
    throw new Error(`"${file.name}" ist keine .xml-Datei. Bitte eine XML-Datei auswählen.`);
  }
  state.xmlContent = await file.text();
  state.xmlFileName = file.name;
  if (!state.xmlContent.trim()) {
    state.xmlContent = null;
    throw new Error(`Die Datei "${file.name}" ist leer.`);
  }
}

async function uploadReference(file) {
  if (!file) {
    state.referenceId = null;
    return;
  }
  if (!/\.pdf$/i.test(file.name)) {
    throw new Error(`"${file.name}" ist keine .pdf-Datei. Bitte eine PDF-Datei auswählen.`);
  }
  setStatus(`Referenz-PDF "${file.name}" wird übertragen …`);
  const response = await fetch('/api/reference', {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  });
  if (!response.ok) {
    const { message, details } = await readErrorFromResponse(response);
    const error = new Error(message);
    error.details = details;
    throw error;
  }
  const data = await response.json();
  state.referenceId = data.referenceId;
  state.referenceFileName = data.fileName;
  setStatus(`Referenz-PDF "${data.fileName}" geladen.`);
}

// ------------------------------------------------------------- Hauptvorgang

/** Führt den POST-Aufruf aus und aktualisiert die Anzeige (FR2/FR4/FR5/FR6/FR7). */
async function runComparison({ reason = 'generate' } = {}) {
  if (state.busy) return;
  clearError();

  if (!state.xmlContent) {
    showError('Bitte zuerst eine Test-XML-Datei auswählen.');
    return;
  }
  if (!dom.targetUrl.value.trim()) {
    showError('Bitte eine Ziel-URL für den POST-Aufruf angeben.');
    return;
  }
  if (!dom.templatePath.value.trim()) {
    showError('Bitte einen Vorlagepfad angeben.');
    return;
  }

  setBusy(true);
  setStatus(reason === 'refresh' ? 'Refresh: POST-Aufruf wird wiederholt …' : 'POST-Aufruf läuft …');

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: dom.targetUrl.value.trim(),
        templatePath: dom.templatePath.value.trim(),
        xmlContent: state.xmlContent,
        xmlFileName: state.xmlFileName,
        referenceId: state.referenceId,
        contentType: dom.contentType.value.trim() || undefined,
        extraHeaders: dom.extraHeaders.value,
        lineEnding: dom.lineEnding.value,
        ignoreSymbols: dom.ignoreSymbols.checked,
        ignoreInvisible: dom.ignoreInvisible.checked,
      }),
    });

    if (!response.ok) {
      const { message, details, logFile } = await readErrorFromResponse(response);
      showError(message, details, logFile);
      setStatus('Fehlgeschlagen.');
      return;
    }

    const result = await response.json();
    saveSettings();
    await renderResult(result);
    setStatus(
      `${reason === 'refresh' ? 'Aktualisiert' : 'Fertig'} um ${new Date(result.generatedAt).toLocaleTimeString('de-DE')}.`
    );
  } catch (err) {
    showError(`Die Anfrage konnte nicht ausgeführt werden: ${err.message}`);
    setStatus('Fehlgeschlagen.');
  } finally {
    setBusy(false);
  }
}

// --------------------------------------------------------------- Darstellung

function formatHeaders(headers) {
  return Object.entries(headers ?? {}).map(([name, value]) => `${name}: ${value}`);
}

/**
 * Zeigt den exakt gesendeten Request und die Antwort an – hilft beim Eingrenzen
 * von Endpoint-Problemen. Wird bei Erfolg und bei Fehlern verwendet.
 */
function renderExchange(request, response) {
  const lines = [
    '--- GESENDETER REQUEST ---',
    `POST ${request.targetUrl}`,
    ...formatHeaders(request.headers),
    '',
    `--- GESENDETER BODY (${request.bytes ?? 0} Bytes, Kodierung ${request.encoding ?? 'utf8'}) ---`,
    request.body ?? '',
  ];

  if (response) {
    lines.push(
      '',
      `--- ANTWORT: HTTP ${response.status}${response.statusMessage ? ` ${response.statusMessage}` : ''} ---`,
      ...formatHeaders(response.headers)
    );
    if (typeof response.body === 'string') {
      lines.push('', `--- ANTWORT-BODY (${response.bytes ?? 0} Bytes) ---`, response.body);
    }
  } else {
    lines.push('', '--- ANTWORT ---', 'Keine Antwort erhalten (Verbindungs- oder Zeitfehler).');
  }

  // Reproduziert den Aufruf exakt – zum Gegenprüfen mit Postman, cURL o. Ä.
  if (request.curl) {
    lines.push('', '--- DERSELBE AUFRUF ALS CURL-BEFEHL ---', request.curl);
  }

  dom.diagnosticsContent.textContent = lines.join('\n');
  dom.diagnostics.hidden = false;
  dom.diagnostics.setAttribute('open', '');
}

/** Diagnose nach einem erfolgreichen Durchlauf (Antwort ist das PDF). */
function renderDiagnostics(result) {
  renderExchange(result.request, {
    status: result.response.status,
    headers: { 'content-type': result.response.contentType ?? '(ohne)' },
    bytes: result.response.bytes,
  });
  dom.diagnostics.removeAttribute('open');
}

async function renderResult(result) {
  dom.downloadLink.href = `${result.generatedUrl}?download=1`;
  dom.downloadLink.hidden = false;
  renderDiagnostics(result);

  if (result.comparisonError) {
    showError(result.comparisonError.message, result.comparisonError.details);
  }

  const comparison = result.comparison;
  if (!comparison) {
    // Ohne Referenz-PDF gibt es nichts zu vergleichen – nur das erzeugte PDF anzeigen.
    dom.summary.hidden = true;
    dom.viewControls.hidden = true;
    dom.tabs.hidden = true;
    dom.markdownPanel.hidden = true;
    dom.stylePanel.hidden = true;
    state.markdown = null;
    state.style = null;
    dom.viewer.hidden = false;
    dom.viewer.replaceChildren();
    await renderSinglePdf(result.generatedUrl);
    return;
  }

  renderSummary(result, comparison);
  renderMarkdownDiff(comparison.markdown);
  renderStyleComparison(comparison.style);
  dom.tabs.hidden = false;
  await renderPages(result, comparison);
  applyActiveTab();
}

/** Verdrahtet den Vergleich mit einem anderen Werkzeug (wird einmalig beim Start aufgerufen). */
function wireCaptureComparison() {
  dom.captureUrl.textContent = `${window.location.origin}/api/capture`;
  dom.captureCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(dom.captureUrl.textContent);
      dom.captureStatus.textContent = 'Adresse kopiert.';
    } catch {
      dom.captureStatus.textContent = 'Kopieren nicht möglich – Adresse bitte manuell übernehmen.';
    }
  });
  dom.captureCompare.addEventListener('click', vergleicheMitAufzeichnung);
  dom.captureApply.addEventListener('click', uebernehmeCaptureHeader);
  dom.captureReset.addEventListener('click', async () => {
    await fetch('/api/capture', { method: 'DELETE' }).catch(() => {});
    letzterCaptureVergleich = null;
    dom.captureResult.hidden = true;
    dom.captureStatus.textContent = 'Aufzeichnung verworfen.';
  });
}

// ------------------------------------------------------- Markdown-Vergleich

/** Baut die zeilenweise Gegenüberstellung der beiden Markdown-Fassungen. */
function renderMarkdownDiff(markdown) {
  state.markdown = markdown ?? null;
  if (!markdown) {
    dom.markdownRows.replaceChildren();
    dom.markdownSummary.textContent = '';
    return;
  }

  dom.markdownSummary.textContent = markdown.identical
    ? 'Die Textfassungen stimmen überein.'
    : `${markdown.totals.changed} geänderte, ${markdown.totals.removed} nur in der Referenz, ` +
      `${markdown.totals.added} nur im generierten Dokument`;

  dom.markdownDownload.href = URL.createObjectURL(new Blob([markdown.generated], { type: 'text/markdown' }));

  paintMarkdownRows();
}

function paintMarkdownRows() {
  const markdown = state.markdown;
  if (!markdown) return;

  const nurAbweichungen = dom.toggleOnlyDiff.checked;
  const rows = nurAbweichungen ? markdown.rows.filter((row) => row.type !== 'equal') : markdown.rows;

  if (rows.length === 0) {
    const leer = document.createElement('p');
    leer.className = 'markdown-empty';
    leer.textContent = nurAbweichungen
      ? 'Keine Abweichungen in der Textfassung gefunden.'
      : 'Keine Textinhalte gefunden.';
    dom.markdownRows.replaceChildren(leer);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    fragment.append(buildMarkdownRow(row));
  }
  dom.markdownRows.replaceChildren(fragment);
}

const ROW_BACKGROUND = {
  removed: { reference: 'md-removed-bg', generated: null },
  added: { reference: null, generated: 'md-added-bg' },
  changed: { reference: 'md-changed-bg', generated: 'md-changed-bg' },
  equal: { reference: null, generated: null },
};

function buildMarkdownRow(row) {
  const element = document.createElement('div');
  element.className = `markdown-row ${row.type}`;

  const hintergrund = ROW_BACKGROUND[row.type] ?? ROW_BACKGROUND.equal;
  element.append(
    lineNumber(row.referenceLine),
    textCell(row.reference, hintergrund.reference, row.segments?.reference),
    lineNumber(row.generatedLine),
    textCell(row.generated, hintergrund.generated, row.segments?.generated)
  );
  return element;
}

function lineNumber(value) {
  const cell = document.createElement('span');
  cell.className = 'md-line-number';
  cell.textContent = value === null || value === undefined ? '' : String(value);
  return cell;
}

/** Textzelle; bei geänderten Zeilen werden die abweichenden Wörter zusätzlich ausgezeichnet. */
function textCell(text, backgroundClass, segments) {
  const cell = document.createElement('span');
  cell.className = `md-text${backgroundClass ? ` ${backgroundClass}` : ''}`;

  if (text === null || text === undefined) {
    cell.textContent = '';
    return cell;
  }

  if (segments) {
    for (const segment of segments) {
      if (segment.changed) {
        const mark = document.createElement('mark');
        mark.textContent = segment.text;
        cell.append(mark);
      } else {
        cell.append(document.createTextNode(segment.text));
      }
    }
    return cell;
  }

  cell.textContent = text;
  return cell;
}

// --------------------------------------------------- Font- und Stilvergleich

/** Baut die Ansicht mit Stilabweichungen und Schriftinventar. */
function renderStyleComparison(style) {
  state.style = style ?? null;
  if (!style) {
    dom.styleDeviations.replaceChildren();
    dom.styleInventory.replaceChildren();
    dom.styleSummary.textContent = '';
    return;
  }

  const { totals } = style;
  const arten = Object.entries(totals.byKind)
    .filter(([, anzahl]) => anzahl > 0)
    .map(([art, anzahl]) => `${anzahl}× ${art}`);

  dom.styleSummary.textContent = style.identical
    ? 'Schriftarten, -größen, -schnitte und Farben stimmen überein.'
    : `${totals.deviations} Stilabweichung(en) auf Seite(n) ${totals.affectedPages.join(', ') || '–'}` +
      (arten.length > 0 ? ` – ${arten.join(', ')}` : '');
  dom.styleColorHint.hidden = style.colorsResolved !== false;

  renderStyleDeviations(style.deviations);
  renderStyleInventory(style.inventory);
}

function renderStyleDeviations(deviations) {
  if (!deviations || deviations.length === 0) {
    const leer = document.createElement('p');
    leer.className = 'style-empty';
    leer.textContent = 'Keine Stilabweichungen bei übereinstimmendem Text gefunden.';
    dom.styleDeviations.replaceChildren(leer);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const abweichung of deviations) {
    const eintrag = document.createElement('div');
    eintrag.className = 'style-entry';

    const kopf = document.createElement('div');
    kopf.className = 'style-entry-head';

    const seite = document.createElement('span');
    seite.className = 'style-entry-page';
    seite.textContent = `Seite ${abweichung.pageNumber}`;

    const text = document.createElement('span');
    text.className = 'style-entry-text';
    text.textContent = `„${abweichung.text}"`;

    kopf.append(seite, text);
    for (const art of abweichung.differences) {
      const chip = document.createElement('span');
      chip.className = 'style-chip';
      chip.textContent = art;
      kopf.append(chip);
    }

    const pfeil = document.createElement('span');
    pfeil.className = 'style-arrow';
    pfeil.textContent = '→';

    eintrag.append(
      kopf,
      styleValue(abweichung.reference, abweichung.referenceDescription, 'Referenz'),
      pfeil,
      styleValue(abweichung.generated, abweichung.generatedDescription, 'Generiert')
    );
    fragment.append(eintrag);
  }
  dom.styleDeviations.replaceChildren(fragment);
}

function styleValue(style, description, label) {
  const element = document.createElement('span');
  element.className = 'style-value';
  element.title = `${label}: ${description}`;
  if (style?.color) element.append(colorDot(style.color));
  element.append(document.createTextNode(description));
  return element;
}

function colorDot(color) {
  const punkt = document.createElement('span');
  punkt.className = 'color-dot';
  punkt.style.background = color;
  punkt.title = color;
  return punkt;
}

const INVENTORY_STATUS = {
  equal: 'in beiden',
  'only-reference': 'nur in der Referenz',
  'only-generated': 'nur im generierten',
  'count-differs': 'unterschiedlich häufig',
};

function renderStyleInventory(inventory) {
  const fragment = document.createDocumentFragment();
  for (const titel of ['Schrift', 'Status', 'Referenz', 'Generiert']) {
    const kopf = document.createElement('span');
    kopf.className = 'style-table-head';
    if (titel === 'Referenz' || titel === 'Generiert') kopf.classList.add('numeric');
    kopf.textContent = titel;
    fragment.append(kopf);
  }

  for (const row of inventory ?? []) {
    const klasse = row.status === 'equal' ? '' : ` style-row-${row.status}`;

    const name = document.createElement('span');
    name.className = `style-name${klasse}`;
    if (row.style?.color) name.append(colorDot(row.style.color));
    name.append(document.createTextNode(row.description));

    const status = document.createElement('span');
    status.className = `style-status${klasse}`;
    status.textContent = INVENTORY_STATUS[row.status] ?? row.status;

    fragment.append(name, status, wordCount(row.reference, klasse), wordCount(row.generated, klasse));
  }

  dom.styleInventory.replaceChildren(fragment);
}

function wordCount(seite, klasse) {
  const zelle = document.createElement('span');
  zelle.className = `numeric${klasse}`;
  zelle.textContent = seite ? `${seite.words} Wörter` : '–';
  if (seite) zelle.title = `Seite(n): ${seite.pages.join(', ')}`;
  return zelle;
}

// ------------------------------ Vergleich mit einem anderen Werkzeug (Postman)

/** Merkt sich den letzten Vergleich, damit die Header übernommen werden können. */
let letzterCaptureVergleich = null;

async function vergleicheMitAufzeichnung() {
  if (!state.xmlContent) {
    dom.captureStatus.textContent = 'Bitte zuerst eine Test-XML-Datei auswählen.';
    return;
  }

  dom.captureStatus.textContent = 'Vergleiche …';
  try {
    const response = await fetch('/api/capture/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templatePath: dom.templatePath.value.trim(),
        xmlContent: state.xmlContent,
        xmlFileName: state.xmlFileName,
        contentType: dom.contentType.value.trim() || undefined,
        extraHeaders: dom.extraHeaders.value,
        lineEnding: dom.lineEnding.value,
      }),
    });

    if (!response.ok) {
      const { message } = await readErrorFromResponse(response);
      dom.captureStatus.textContent = message;
      dom.captureResult.hidden = true;
      return;
    }

    const daten = await response.json();
    letzterCaptureVergleich = daten.comparison;
    zeigeCaptureVergleich(daten);
    dom.captureStatus.textContent = `Aufgezeichnet um ${new Date(daten.captured.receivedAt).toLocaleTimeString('de-DE')}.`;
  } catch (err) {
    dom.captureStatus.textContent = `Vergleich fehlgeschlagen: ${err.message}`;
  }
}

function zeigeCaptureVergleich({ comparison, captured }) {
  dom.captureResult.hidden = false;

  // Hinweise
  const hinweise = document.createDocumentFragment();
  for (const hinweis of comparison.hints) {
    const punkt = document.createElement('li');
    punkt.textContent = hinweis;
    if (!comparison.identical) punkt.className = 'wichtig';
    hinweise.append(punkt);
  }
  dom.captureHints.replaceChildren(hinweise);

  // Header-Gegenüberstellung
  const tabelle = document.createDocumentFragment();
  for (const titel of ['Header', 'Anwendung', 'Aufgezeichnet']) {
    const kopf = document.createElement('span');
    kopf.className = 'kopf';
    kopf.textContent = titel;
    tabelle.append(kopf);
  }
  for (const header of comparison.headers) {
    const klasse =
      header.status === 'gleich'
        ? header.automatic || header.toolSpecific
          ? ' zeile-automatisch'
          : ''
        : ` zeile-${header.status}`;
    tabelle.append(
      zelle(header.name, klasse),
      zelle(header.application ?? '–', klasse),
      zelle(header.captured ?? '–', klasse)
    );
  }
  dom.captureHeaders.replaceChildren(tabelle);

  // Body
  const body = comparison.body;
  const zeilen = [
    `Body: Anwendung ${body.applicationBytes} Bytes, aufgezeichnet ${body.capturedBytes} Bytes` +
      (body.identical ? ' – identisch' : ''),
    `Zeilenenden: Anwendung ${body.lineEndings.application.art}, aufgezeichnet ${body.lineEndings.captured.art}`,
  ];
  if (!body.identical && body.firstDifferenceAt !== null) {
    zeilen.push(
      '',
      `Erste Abweichung an Byte ${body.firstDifferenceAt}:`,
      `  Anwendung    …${body.applicationContext.text}…`,
      `               ${body.applicationContext.hex}`,
      `  Aufgezeichnet …${body.capturedContext.text}…`,
      `               ${body.capturedContext.hex}`
    );
  }
  zeilen.push('', '--- Aufgezeichneter Body ---', captured.body);
  dom.captureBody.textContent = zeilen.join('\n');

  const uebernehmbar = Boolean(comparison.suggestedHeaders || comparison.suggestedContentType);
  dom.captureAdopt.hidden = !uebernehmbar;
}

function zelle(text, klasse) {
  const element = document.createElement('span');
  element.className = klasse.trim();
  element.textContent = text;
  return element;
}

function uebernehmeCaptureHeader() {
  if (!letzterCaptureVergleich) return;

  if (letzterCaptureVergleich.suggestedContentType) {
    dom.contentType.value = letzterCaptureVergleich.suggestedContentType;
  }
  if (letzterCaptureVergleich.suggestedHeaders) {
    const vorhanden = dom.extraHeaders.value.trim();
    dom.extraHeaders.value = vorhanden
      ? `${vorhanden}\n${letzterCaptureVergleich.suggestedHeaders}`
      : letzterCaptureVergleich.suggestedHeaders;
  }
  saveSettings();
  dom.advanced?.setAttribute('open', '');
  dom.captureStatus.textContent = 'Header übernommen – jetzt erneut „Vergleich generieren" klicken.';
}

// ------------------------------------------------------------------- Reiter

const TABS = ['pdf', 'markdown', 'style'];

function setActiveTab(tab) {
  state.activeTab = TABS.includes(tab) ? tab : 'pdf';
  applyActiveTab();
  saveSettings();
}

function applyActiveTab() {
  const aktiv = state.activeTab;
  const ergebnisVorhanden = !dom.tabs.hidden;

  dom.tabPdf.setAttribute('aria-selected', String(aktiv === 'pdf'));
  dom.tabMarkdown.setAttribute('aria-selected', String(aktiv === 'markdown'));
  dom.tabStyle.setAttribute('aria-selected', String(aktiv === 'style'));

  dom.viewer.hidden = aktiv !== 'pdf' || dom.viewer.childElementCount === 0;
  dom.viewControls.hidden = aktiv !== 'pdf' || !ergebnisVorhanden || !state.markdown;
  dom.markdownPanel.hidden = aktiv !== 'markdown' || !ergebnisVorhanden;
  dom.stylePanel.hidden = aktiv !== 'style' || !ergebnisVorhanden;
}

function renderSummary(result, comparison) {
  dom.summary.hidden = false;
  dom.summaryStatus.textContent = comparison.identical ? 'identisch' : 'Abweichungen gefunden';
  dom.summaryStatus.className = comparison.identical ? 'status-equal' : 'status-different';
  dom.summaryPages.textContent = `${comparison.pageCount.reference} / ${comparison.pageCount.generated}${
    comparison.pageCountMatches ? '' : ' (unterschiedliche Seitenzahl!)'
  }`;
  dom.summaryDiffPages.textContent = comparison.differingPageNumbers.length
    ? comparison.differingPageNumbers.join(', ')
    : 'keine';
  dom.summaryWords.textContent = `${comparison.totals.removedWords} / ${comparison.totals.addedWords}`;
  dom.summaryDuration.textContent = `${result.response.durationMs} ms`;

  // Transparent machen, welche Inhalte vom Vergleich ausgenommen wurden.
  const ausgenommen = [];
  if (comparison.symbolGlyphs?.ignored && comparison.symbolGlyphs.count > 0) {
    ausgenommen.push(`${comparison.symbolGlyphs.count} Symbolzeichen (z. B. Checkbox-Kästchen)`);
  }
  if (comparison.invisibleText?.ignored && comparison.invisibleText.count > 0) {
    ausgenommen.push(`${comparison.invisibleText.count} nicht sichtbare Textstellen`);
  }

  dom.summarySymbols.hidden = ausgenommen.length === 0;
  if (ausgenommen.length > 0) {
    dom.summarySymbols.textContent =
      `Vom Textvergleich ausgenommen: ${ausgenommen.join(' und ')}. ` +
      'Abschaltbar unter „Erweiterte Einstellungen".';
  }
}

async function loadPdf(url) {
  return pdfjsLib.getDocument({ url, standardFontDataUrl: './standard_fonts/' }).promise;
}

async function renderSinglePdf(url) {
  const doc = await loadPdf(url);
  const jobs = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const row = document.createElement('article');
    row.className = 'page-row';
    row.innerHTML = `<header><h3>Seite ${pageNumber}</h3></header>`;
    const panes = document.createElement('div');
    panes.className = 'panes';
    const pane = createPane('Generiertes PDF', doc, pageNumber, [], null);
    panes.append(pane.element);
    row.append(panes);
    dom.viewer.append(row);
    if (pane.job) jobs.push(pane.job);
  }
  await runRenderJobs(jobs);
}

async function renderPages(result, comparison) {
  dom.viewer.hidden = false;
  dom.viewer.replaceChildren();
  dom.viewControls.hidden = false;

  const [referenceDoc, generatedDoc] = await Promise.all([
    result.referenceUrl ? loadPdf(result.referenceUrl) : null,
    loadPdf(result.generatedUrl),
  ]);

  const jobs = [];
  for (const page of comparison.pages) {
    const row = document.createElement('article');
    row.className = 'page-row';

    const header = document.createElement('header');
    const title = document.createElement('h3');
    title.textContent = `Seite ${page.pageNumber}`;
    const badge = document.createElement('span');
    badge.className = `page-badge ${page.identical ? 'status-equal' : 'status-different'}`;
    badge.textContent = describeStatus(page);
    header.append(title, badge);
    row.append(header);

    const panes = document.createElement('div');
    panes.className = 'panes';

    // Die Referenz wird ohne Markierungen dargestellt.
    const referencePane =
      page.referencePresent && referenceDoc
        ? createPane('Referenz-PDF', referenceDoc, page.pageNumber, [], page.reference)
        : { element: missingPane('Referenz-PDF', 'Diese Seite existiert nur im generierten PDF.') };
    const generatedPane = page.generatedPresent
      ? createPane('Generiertes PDF', generatedDoc, page.pageNumber, page.generated?.highlights ?? [], page.generated)
      : { element: missingPane('Generiertes PDF', 'Diese Seite fehlt im generierten PDF.') };

    panes.append(referencePane.element, generatedPane.element);
    row.append(panes);
    // Erst einhängen, dann rendern – die Zeichenbreite ergibt sich aus dem Layout.
    dom.viewer.append(row);

    for (const pane of [referencePane, generatedPane]) {
      if (pane.job) jobs.push(pane.job);
    }
  }

  await runRenderJobs(jobs);
}

/** Rendert die Seiten nacheinander (begrenzt den Speicherbedarf bei vielen Seiten). */
async function runRenderJobs(jobs) {
  state.renderJobs = jobs;
  for (const job of jobs) {
    await job.render();
  }
}

/** Blendet die Markierungen ein oder aus, ohne die Seiten neu zu zeichnen. */
function applyHighlightVisibility() {
  dom.viewer.classList.toggle('highlights-hidden', !dom.toggleHighlights.checked);
}

/** Zeichnet die Seiten neu, wenn sich die verfügbare Breite spürbar geändert hat. */
async function redrawIfWidthChanged() {
  const betroffen = state.renderJobs.filter((job) => {
    const gezeichnet = Number(job.wrapper.dataset.renderedWidth || 0);
    return job.wrapper.isConnected && Math.abs(job.wrapper.clientWidth - gezeichnet) > 20;
  });
  if (betroffen.length === 0) return;

  for (const job of betroffen) {
    job.wrapper._renderTask?.cancel?.();
  }
  for (const job of betroffen) {
    await job.render();
  }
}

function describeStatus(page) {
  if (page.status === 'only-in-reference') return 'nur im Referenz-PDF';
  if (page.status === 'only-in-generated') return 'nur im generierten PDF';
  if (page.identical) return 'identisch';
  const { removedWords, addedWords } = page.counts;
  const teile = [];
  if (addedWords > 0) teile.push(`${addedWords} weicht ab`);
  if (removedWords > 0) teile.push(`${removedWords} fehlt`);
  return `abweichend (${teile.join(', ')})`;
}

function missingPane(title, message) {
  const pane = document.createElement('div');
  pane.className = 'pane';
  const heading = document.createElement('div');
  heading.className = 'pane-title';
  heading.textContent = title;
  const box = document.createElement('div');
  box.className = 'pane-missing';
  box.textContent = message;
  pane.append(heading, box);
  return pane;
}

/**
 * Erzeugt das Gerüst einer Seitenansicht. Gezeichnet wird erst über `job.render()`,
 * wenn das Element im DOM hängt – dann steht die verfügbare Breite fest und die
 * Seite kann sie voll ausnutzen (kein ungenutzter Rand zwischen den Dokumenten).
 */
function createPane(title, doc, pageNumber, highlights, geometry = null) {
  const pane = document.createElement('div');
  pane.className = 'pane';

  const heading = document.createElement('div');
  heading.className = 'pane-title';
  heading.textContent = `${title}${highlights.length ? ` – ${highlights.length} markierte Stelle(n)` : ''}`;
  pane.append(heading);

  if (pageNumber > doc.numPages) {
    const box = document.createElement('div');
    box.className = 'pane-missing';
    box.textContent = 'Seite nicht vorhanden.';
    pane.append(box);
    return { element: pane, job: null };
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'page-canvas-wrapper';
  pane.append(wrapper);

  return {
    element: pane,
    job: { wrapper, doc, pageNumber, highlights, geometry, render: () => renderPageInto(wrapper, doc, pageNumber, highlights, geometry) },
  };
}

/** Zeichnet eine PDF-Seite in der Breite aus, die im Layout tatsächlich zur Verfügung steht. */
async function renderPageInto(wrapper, doc, pageNumber, highlights, geometry) {
  const page = await doc.getPage(pageNumber);
  const unscaled = page.getViewport({ scale: 1 });

  const cssWidth = Math.max(wrapper.clientWidth || 0, MIN_PAGE_WIDTH);
  // Bitmap in Gerätepixeln zeichnen, damit die Darstellung scharf bleibt.
  const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const viewport = page.getViewport({ scale: (cssWidth / unscaled.width) * pixelRatio });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  wrapper.replaceChildren(canvas);
  wrapper.dataset.renderedWidth = String(cssWidth);

  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
  wrapper._renderTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return;
    throw err;
  }

  // FR6: Abweichungen als Overlays über dem Seiteninhalt.
  // Prozentangaben, damit die Markierungen jeder Skalierung des Canvas folgen.
  const baseWidth = geometry?.width || unscaled.width;
  const baseHeight = geometry?.height || unscaled.height;
  for (const box of highlights) {
    const marker = document.createElement('div');
    // "missing" = Text der Referenz, der hier fehlt -> gestrichelt dargestellt
    marker.className = box.type === 'missing' ? 'highlight missing' : 'highlight';
    marker.style.left = `${(box.x / baseWidth) * 100}%`;
    marker.style.top = `${(box.y / baseHeight) * 100}%`;
    marker.style.width = `${(box.width / baseWidth) * 100}%`;
    marker.style.height = `${(box.height / baseHeight) * 100}%`;
    marker.title =
      box.type === 'missing'
        ? `Fehlt gegenüber der Referenz: ${box.text ?? ''}`.trim()
        : `Weicht von der Referenz ab: ${box.text ?? ''}`.trim();
    wrapper.append(marker);
  }
}

// ------------------------------------------------------------------- Events

function wireUp() {
  loadSettings();

  dom.xmlFile.addEventListener('change', async (event) => {
    clearError();
    try {
      await handleXmlFile(event.target.files?.[0] ?? null);
      setStatus(state.xmlFileName ? `Test-XML "${state.xmlFileName}" geladen.` : '');
    } catch (err) {
      showError(err.message);
    }
    dom.refreshButton.disabled = !canRefresh();
  });

  dom.referenceFile.addEventListener('change', async (event) => {
    clearError();
    try {
      await uploadReference(event.target.files?.[0] ?? null);
    } catch (err) {
      showError(err.message, err.details);
      setStatus('');
    }
  });

  dom.form.addEventListener('submit', (event) => {
    event.preventDefault();
    runComparison({ reason: 'generate' });
  });

  // FR7: Refresh wiederholt den POST-Aufruf mit den aktuell eingegebenen Werten.
  dom.refreshButton.addEventListener('click', () => runComparison({ reason: 'refresh' }));

  // NFR3: Eingaben bleiben erhalten.
  dom.targetUrl.addEventListener('input', () => {
    saveSettings();
    dom.refreshButton.disabled = !canRefresh();
  });
  dom.templatePath.addEventListener('input', () => {
    saveSettings();
    dom.refreshButton.disabled = !canRefresh();
  });
  dom.contentType.addEventListener('input', saveSettings);
  dom.extraHeaders.addEventListener('input', saveSettings);
  dom.lineEnding.addEventListener('change', saveSettings);
  dom.ignoreSymbols.addEventListener('change', saveSettings);
  dom.ignoreInvisible.addEventListener('change', saveSettings);

  // Markierungen ein-/ausblenden (Zustand bleibt erhalten)
  dom.toggleHighlights.addEventListener('change', () => {
    applyHighlightVisibility();
    saveSettings();
  });
  applyHighlightVisibility();

  // Reiter: PDF-Vergleich / Markdown-Vergleich / Font & Stil
  const tabButtons = { pdf: dom.tabPdf, markdown: dom.tabMarkdown, style: dom.tabStyle };
  for (const [name, button] of Object.entries(tabButtons)) {
    button.addEventListener('click', () => setActiveTab(name));
  }
  dom.tabs.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const richtung = event.key === 'ArrowRight' ? 1 : -1;
    const ziel = TABS[(TABS.indexOf(state.activeTab) + richtung + TABS.length) % TABS.length];
    setActiveTab(ziel);
    tabButtons[ziel].focus();
  });

  dom.toggleOnlyDiff.addEventListener('change', () => {
    paintMarkdownRows();
    saveSettings();
  });
  applyActiveTab();
  wireCaptureComparison();

  // Nach einer Größenänderung des Fensters neu zeichnen, damit die Seiten scharf bleiben.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawIfWidthChanged, RESIZE_DELAY_MS);
  });
}

if (typeof document !== 'undefined') {
  wireUp();
}
