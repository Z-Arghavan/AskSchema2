/* ══════════════════════════════════════════
   server.js  —  local persistence server
   Serves static files + stores Q&A log
   to data/qa_log.json so analytics survive
   browser resets, port changes, and reloads.

   Usage:  node server.js
   Opens:  http://localhost:3000
   ══════════════════════════════════════════ */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT     = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'qa_log.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

/* ── File helpers ── */
function readLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch { return []; }
}

function writeLog(entries) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2), 'utf8');
}

/* ── MIME types ── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css',
  '.js'  : 'application/javascript',
  '.json': 'application/json',
  '.ttl' : 'text/turtle',
  '.ico' : 'image/x-icon',
  '.png' : 'image/png',
  '.svg' : 'image/svg+xml',
};

/* ── Request handler ── */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS (needed if fetching from file:// during dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* ── GET /api/log — return full log ── */
  if (req.method === 'GET' && url.pathname === '/api/log') {
    const log = readLog();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(log));
    return;
  }

  /* ── POST /api/log — append one entry ── */
  if (req.method === 'POST' && url.pathname === '/api/log') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const entry = JSON.parse(body);
        const log   = readLog();
        log.push(entry);
        writeLog(log);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, total: log.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  /* ── DELETE /api/log — clear log ── */
  if (req.method === 'DELETE' && url.pathname === '/api/log') {
    writeLog([]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  /* ── Static file serving ── */
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, filePath);

  // Safety: prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + url.pathname);
      return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  AskOntology server ready');
  console.log(`  App:      http://localhost:${PORT}`);
  console.log(`  Log file: ${LOG_FILE}`);
  console.log('');
});
