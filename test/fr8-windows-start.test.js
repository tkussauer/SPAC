import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** FR8 – Die Anwendung ist von einem Windows-Desktop aus per Batch-Datei startbar. */
test('FR8: start.bat existiert und startet Server sowie Browser', async () => {
  const batPath = path.join(root, 'start.bat');
  await access(batPath, constants.F_OK);
  const bat = await readFile(batPath, 'utf8');

  assert.match(bat, /\r\n/, 'Batch-Dateien benötigen Windows-Zeilenenden (CRLF)');
  assert.match(bat, /cd \/d "%~dp0"/, 'Das Arbeitsverzeichnis muss auf den Skriptordner gesetzt werden');
  assert.match(bat, /node "src\\server\\index\.js"/, 'Der Server wird nicht gestartet');
  assert.match(bat, /open-browser\.cmd/, 'Der Browser wird nicht geöffnet');
  assert.match(bat, /npm install/, 'Erstinstallation fehlt (NFR4: Doppelklick genügt)');
  assert.match(bat, /npm run build/, 'Der Build-Schritt fehlt');
  assert.match(bat, /where node/, 'Es wird nicht geprüft, ob Node.js installiert ist');
});

test('FR8: open-browser.cmd öffnet die Anwendung im Standardbrowser', async () => {
  const cmdPath = path.join(root, 'scripts/open-browser.cmd');
  await access(cmdPath, constants.F_OK);
  const cmd = await readFile(cmdPath, 'utf8');

  assert.match(cmd, /\r\n/, 'Batch-Dateien benötigen Windows-Zeilenenden (CRLF)');
  assert.match(cmd, /start "" "%URL%"/, 'Der Standardbrowser wird nicht mit der URL geöffnet');
  assert.match(cmd, /http:\/\/127\.0\.0\.1:3000/, 'Es fehlt eine Standard-URL als Fallback');
});

test('FR8: package.json stellt die benötigten Skripte bereit', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node src/server/index.js');
  assert.equal(pkg.scripts.build, 'node scripts/build.mjs');
  assert.equal(pkg.scripts.prestart, 'node scripts/build.mjs', 'npm start muss das Frontend mitbauen');
  assert.equal(pkg.scripts.pretest, 'node scripts/build.mjs', 'npm test muss ohne vorherigen Build funktionieren');
  assert.ok(pkg.scripts.test.includes('--test'));
  assert.equal(pkg.type, 'module');
});

test('FR8/NFR1: Es werden keine nativen oder Online-Abhängigkeiten benötigt', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['express', 'pdfjs-dist']);

  // Der Client lädt pdf.js-Worker und Schriften lokal (kein CDN).
  const client = await readFile(path.join(root, 'src/client/main.js'), 'utf8');
  assert.match(client, /workerSrc\s*=\s*'\.\/pdf\.worker\.min\.mjs'/);
  assert.doesNotMatch(client, /https?:\/\/(?!127\.0\.0\.1|localhost)/, 'Der Client darf keine externen URLs laden');

  const html = await readFile(path.join(root, 'src/client/index.html'), 'utf8');
  assert.doesNotMatch(html, /src="https?:\/\//, 'Die Seite darf keine externen Skripte einbinden');
});
