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
  advanced: el('advanced'),
  viewControls: el('view-controls'),
  toggleHighlights: el('toggle-highlights'),
  diagnostics: el('diagnostics'),
  diagnosticsContent: el('diagnostics-content'),
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
    if (typeof saved.showHighlights === 'boolean') dom.toggleHighlights.checked = saved.showHighlights;
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
        showHighlights: dom.toggleHighlights.checked,
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
    // Ohne Referenz-PDF gibt es nichts zu markieren – nur das erzeugte PDF anzeigen.
    dom.summary.hidden = true;
    dom.viewControls.hidden = true;
    dom.viewer.hidden = false;
    dom.viewer.replaceChildren();
    await renderSinglePdf(result.generatedUrl);
    return;
  }

  renderSummary(result, comparison);
  await renderPages(result, comparison);
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

  // Markierungen ein-/ausblenden (Zustand bleibt erhalten)
  dom.toggleHighlights.addEventListener('change', () => {
    applyHighlightVisibility();
    saveSettings();
  });
  applyHighlightVisibility();

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
