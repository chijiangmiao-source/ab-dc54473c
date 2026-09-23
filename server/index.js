// index.js — 零依赖 HTTP 服务：提供页面静态资源与 /healthz
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = normalize(join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + '/') && filePath !== PUBLIC_DIR) {
    res.writeHead(403); return res.end('Forbidden');
  }
  if (!existsSync(filePath) || !(await stat(filePath)).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }
  const body = await readFile(filePath);
  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url.startsWith('/healthz?')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }
  serveStatic(req, res).catch((err) => {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Server Error: ${err.message}`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`witness ledger listening on http://${HOST}:${PORT}`);
});
