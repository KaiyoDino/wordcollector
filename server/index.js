import 'dotenv/config';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDatabase } from './db.js';
import { createWordStore, createSettingsStore } from './words.js';
import { createApiRouter } from './routes/api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Starts the app and resolves to its URL. A desktop wrapper (Electron) can call this
// with its own dataDir, e.g. app.getPath('userData'), then load the URL in a window.
export async function startServer({ port = 5173, dataDir = path.join(ROOT, 'data') } = {}) {
  const db = await openDatabase(dataDir);
  const settings = createSettingsStore(db);
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', createApiRouter({ words: createWordStore(db), settings }));
  app.use(express.static(path.join(ROOT, 'public')));

  const server = await listen(app, port);
  const hasKeys = Boolean((settings.get('mw_collegiate_key') || process.env.MW_COLLEGIATE_KEY)
    && (settings.get('mw_thesaurus_key') || process.env.MW_THESAURUS_KEY));
  return { url: `http://localhost:${server.address().port}`, server, hasKeys };
}

// Binds to localhost only; tries the next port if one is taken.
function listen(app, port, attempts = 10) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempts > 1) resolve(listen(app, port + 1, attempts - 1));
      else reject(err);
    });
  });
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { url, hasKeys } = await startServer({ port: Number(process.env.PORT) || 5173 });
  console.log(`wordcollector running at ${url}`);
  if (!hasKeys) console.log('Note: Merriam-Webster keys are missing. Add them in the app under Settings (see README).');
  if (!process.argv.includes('--no-open')) openBrowser(url);
}
