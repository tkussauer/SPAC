#!/usr/bin/env node
/**
 * Build des Frontends: bündelt den Client (inkl. pdf.js) nach public/.
 * Alle Assets werden lokal abgelegt, damit die Anwendung ohne Internet läuft (NFR1).
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = path.join(root, 'src/client');
const outDir = path.join(root, 'public');
const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function build() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [path.join(clientDir, 'main.js')],
    outfile: path.join(outDir, 'app.js'),
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    platform: 'browser',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });

  if (result.errors.length > 0) {
    throw new Error(`esbuild meldete ${result.errors.length} Fehler.`);
  }

  await cp(path.join(clientDir, 'index.html'), path.join(outDir, 'index.html'));
  await cp(path.join(clientDir, 'styles.css'), path.join(outDir, 'styles.css'));

  // pdf.js-Worker und Standard-Schriften lokal bereitstellen
  await cp(path.join(pdfjsDir, 'build/pdf.worker.min.mjs'), path.join(outDir, 'pdf.worker.min.mjs'));
  const standardFonts = path.join(pdfjsDir, 'standard_fonts');
  if (await exists(standardFonts)) {
    await cp(standardFonts, path.join(outDir, 'standard_fonts'), { recursive: true });
  }
  const cmaps = path.join(pdfjsDir, 'cmaps');
  if (await exists(cmaps)) {
    await cp(cmaps, path.join(outDir, 'cmaps'), { recursive: true });
  }

  console.log(`Build fertig -> ${path.relative(root, outDir)}/`);
}

build().catch((err) => {
  console.error('Build fehlgeschlagen:', err.message);
  process.exitCode = 1;
});
