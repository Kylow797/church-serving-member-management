// Entry point: boots config, DB, HTTP API, static web build and the generation timer.
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import express from 'express';
import { DbError, openDb, syncConfig } from './db/index.js';
import { ConfigError, configPath, loadConfig } from './config.js';
import { createApi } from './routes.js';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT) || 3001;

// Startup failures (bad config, unopenable or too-new DB) print one clear message, not a stack.
function fatal(e) {
  console.error(e instanceof ConfigError || e instanceof DbError ? e.message : e);
  process.exit(1);
}

let config;
try {
  config = loadConfig();
} catch (e) {
  fatal(e);
}

let db;
let synced;
try {
  db = openDb();
  synced = syncConfig(db, config);
} catch (e) {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  fatal(e);
}

const { router, service } = createApi({
  db,
  getConfig: () => config,
  setConfig: (c) => {
    config = c;
  },
});

const app = express();
app.disable('x-powered-by');
app.use('/api', router);

// `npm run dev` passes --dev: Vite serves the web app on :5173, so never serve a stale web/dist here.
const DEV = process.argv.includes('--dev');
const DEV_WEB_URL = 'http://localhost:5173';
const dist = join(ROOT, 'web', 'dist');
const serving = !DEV && existsSync(join(dist, 'index.html'));
const isPageRequest = (req) =>
  (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/assets/') && !extname(req.path);

if (serving) {
  app.use(
    express.static(dist, {
      index: false,
      setHeaders: (res, file) => {
        // Hashed build assets never change; index.html must be revalidated so a rebuild is picked up.
        if (file.startsWith(join(dist, 'assets'))) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  // SPA fallback for client routes (/admin, /availability, ...). Missing files (/assets/old-hash.js) stay 404.
  app.use((req, res, next) => {
    if (!isPageRequest(req)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(dist, 'index.html'));
  });
} else {
  app.use((req, res, next) => {
    if (!isPageRequest(req)) return next();
    const msg = DEV
      ? `This is the API server. In development the web app runs at <a href="${DEV_WEB_URL}">${DEV_WEB_URL}</a>.`
      : 'The web app has not been built. Run <code>npm run build</code>, then restart with <code>npm start</code>, ' +
        'or use <code>npm run dev</code> and open ' +
        `<a href="${DEV_WEB_URL}">${DEV_WEB_URL}</a>.`;
    res.status(DEV ? 200 : 503).type('html').send(`<!doctype html><meta charset="utf-8"><title>Serving Roster</title><p>${msg}</p>`);
  });
}

function automate() {
  try {
    const done = service.runAutomation();
    if (done.length) console.log(`[auto] generated schedule for ${done.join(', ')}`);
  } catch (e) {
    console.error('[auto] generation failed:', e);
  }
}

// Express 5 passes listen errors (EADDRINUSE, EACCES) to this callback instead of throwing.
const server = app.listen(PORT, (err) => {
  if (err) {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Port ${PORT} is already in use. Stop the other process (lsof -i :${PORT}) or set PORT=<free port>.`
        : `Cannot listen on port ${PORT}: ${err.message}`,
    );
    process.exit(1);
  }
  const what = DEV ? 'API' : serving ? 'serving roster' : 'API (web app not built)';
  console.log(
    `${config.settings.churchName} ${what} on http://localhost:${PORT} ` +
      `(config ${configPath()}, people +${synced.added} ~${synced.updated} -${synced.deactivated})`,
  );
  if (DEV) console.log(`Open the app at ${DEV_WEB_URL} (Vite proxies /api to this server)`);
  else if (!serving) console.warn('web/dist is missing: run `npm run build` before `npm start` to serve the web app');
  automate();
});
setInterval(automate, 60 * 60 * 1000).unref();

// Close the DB on shutdown so SQLite checkpoints the WAL back into data/serving.db.
function shutdown() {
  setTimeout(() => process.exit(0), 3000).unref(); // don't hang on a stuck keep-alive socket
  server.close(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  server.closeIdleConnections();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, shutdown);
