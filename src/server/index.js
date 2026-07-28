import { existsSync } from 'node:fs';
import { createApp, PUBLIC_DIR } from './app.js';

const PORT = Number(process.env.PORT || process.env.SPAC_PORT || 3000);
const HOST = process.env.SPAC_HOST || '127.0.0.1';

if (!existsSync(PUBLIC_DIR)) {
  console.error(
    `\n  Das Frontend wurde noch nicht gebaut (${PUBLIC_DIR} fehlt).\n` +
      '  Bitte zuerst "npm run build" ausführen (oder start.bat verwenden).\n'
  );
  process.exit(1);
}

const app = createApp();
const server = app.listen(PORT, HOST, () => {
  console.log(`\n  PDF-Vergleichstool laeuft: http://${HOST}:${PORT}\n  (Beenden mit Strg+C)\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
