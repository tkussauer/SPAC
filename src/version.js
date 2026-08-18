/**
 * Einzige Quelle der Programmversion.
 *
 * Die Zahl steht in package.json. Angezeigt wird nur die Hauptversion als „V3", damit im Titel
 * eine kurze, sprechende Kennung erscheint. So bleibt package.json die maßgebliche Angabe und der
 * Anzeigetext lässt sich daraus ableiten, ohne die Version an mehreren Stellen zu pflegen.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** Vollständige Version, z. B. `3.0.0`. */
export const APP_VERSION = pkg.version;

/** Hauptversion als Anzeigekennung, z. B. `V3`. */
export const APP_VERSION_LABEL = `V${pkg.version.split('.')[0]}`;

/** Anwendungsname ohne Version. */
export const APP_NAME = 'PDF-Vergleichstool';

/** Titel mit Version, z. B. `PDF-Vergleichstool V3`. */
export const APP_TITLE = `${APP_NAME} ${APP_VERSION_LABEL}`;
