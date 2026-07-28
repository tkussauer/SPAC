import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

const STORAGE_KEY = 'spac.pdfcompare.settings.v1';
const RENDER_SCALE = 1.2;

const el = (id) => document.getElementById(id);

const dom = {
  form: el('compare-form'),
  xmlFile: el('xml-file'),
  referenceFile: el('reference-file'),
  targetUrl: el('target-url'),
  templatePath: el('template-path'),
  contentType: el('content-type'),
  advanced: el('advanced'),
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

function showError(message, details) {
  dom.errorMessage.textContent = message;
  if (details) {
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
    if (data?.error?.message) return { message: data.error.message, details: data.error.details ?? null };
  } catch {
    /* keine JSON-Antwort */
  }
  return { message: `Serverfehler (HTTP ${response.status}).`, details: null };
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
      const { message, details } = await readErrorFromResponse(response);
      showError(message, details);
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

/** Zeigt den exakt gesendeten Request an – hilft beim Eingrenzen von Endpoint-Problemen. */
function renderDiagnostics(result) {
  const headerLines = Object.entries(result.request.headers ?? {}).map(([name, value]) => `${name}: ${value}`);
  dom.diagnosticsContent.textContent = [
    `POST ${result.request.targetUrl}`,
    ...headerLines,
    '',
    result.request.body,
    '',
    `--- Antwort: HTTP ${result.response.status}, ${result.response.contentType ?? 'ohne Content-Type'}, ` +
      `${result.response.bytes} Bytes in ${result.response.durationMs} ms`,
  ].join('\n');
  dom.diagnostics.hidden = false;
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
    dom.summary.hidden = true;
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
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const row = document.createElement('article');
    row.className = 'page-row';
    row.innerHTML = `<header><h3>Seite ${pageNumber}</h3></header>`;
    const panes = document.createElement('div');
    panes.className = 'panes';
    panes.append(await buildPane('Generiertes PDF', doc, pageNumber, []));
    row.append(panes);
    dom.viewer.append(row);
  }
}

async function renderPages(result, comparison) {
  dom.viewer.hidden = false;
  dom.viewer.replaceChildren();

  const [referenceDoc, generatedDoc] = await Promise.all([
    result.referenceUrl ? loadPdf(result.referenceUrl) : null,
    loadPdf(result.generatedUrl),
  ]);

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
    panes.append(
      page.referencePresent && referenceDoc
        ? await buildPane('Referenz-PDF', referenceDoc, page.pageNumber, page.reference?.highlights ?? [], page.reference)
        : missingPane('Referenz-PDF', 'Diese Seite existiert nur im generierten PDF.'),
      page.generatedPresent
        ? await buildPane('Generiertes PDF', generatedDoc, page.pageNumber, page.generated?.highlights ?? [], page.generated)
        : missingPane('Generiertes PDF', 'Diese Seite fehlt im generierten PDF.')
    );
    row.append(panes);
    dom.viewer.append(row);
  }
}

function describeStatus(page) {
  if (page.status === 'only-in-reference') return 'nur im Referenz-PDF';
  if (page.status === 'only-in-generated') return 'nur im generierten PDF';
  if (page.identical) return 'identisch';
  const { removedWords, addedWords } = page.counts;
  return `abweichend (${removedWords} fehlend / ${addedWords} zusätzlich)`;
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

async function buildPane(title, doc, pageNumber, highlights, geometry = null) {
  const pane = document.createElement('div');
  pane.className = 'pane';

  const heading = document.createElement('div');
  heading.className = 'pane-title';
  heading.textContent = `${title}${highlights.length ? ` – ${highlights.length} markierte Stelle(n)` : ''}`;
  pane.append(heading);

  const wrapper = document.createElement('div');
  wrapper.className = 'page-canvas-wrapper';
  pane.append(wrapper);

  if (pageNumber > doc.numPages) {
    wrapper.remove();
    const box = document.createElement('div');
    box.className = 'pane-missing';
    box.textContent = 'Seite nicht vorhanden.';
    pane.append(box);
    return pane;
  }

  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  wrapper.style.width = `${Math.floor(viewport.width)}px`;
  wrapper.append(canvas);

  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

  // FR6: Abweichungen als rote Overlays über dem Seiteninhalt.
  // Prozentangaben, damit die Markierungen mitskalieren, wenn das Canvas
  // per CSS (max-width) an die Spaltenbreite angepasst wird.
  const baseWidth = geometry?.width || viewport.width / RENDER_SCALE;
  const baseHeight = geometry?.height || viewport.height / RENDER_SCALE;
  for (const box of highlights) {
    const marker = document.createElement('div');
    marker.className = 'highlight';
    marker.style.left = `${(box.x / baseWidth) * 100}%`;
    marker.style.top = `${(box.y / baseHeight) * 100}%`;
    marker.style.width = `${(box.width / baseWidth) * 100}%`;
    marker.style.height = `${(box.height / baseHeight) * 100}%`;
    marker.title = box.text ? `Abweichung: ${box.text}` : 'Abweichung';
    wrapper.append(marker);
  }

  return pane;
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
}

if (typeof document !== 'undefined') {
  wireUp();
}
