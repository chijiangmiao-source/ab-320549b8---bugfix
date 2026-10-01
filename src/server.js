import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { simulate } from './sim.js';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(ROOT, '..', 'web', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(DIST, urlPath));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('未找到资源，请先运行 npm run build。');
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { status: 'ok', service: 'inertial-logic-review', time: Date.now() });
    }
    if (req.method === 'POST' && url.pathname === '/api/review') {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf-8');
        let config;
        try {
          config = JSON.parse(raw || '{}');
        } catch {
          return sendJson(res, 400, { ok: false, errors: [{ code: 'BAD_JSON', message: '请求体不是合法 JSON。' }] });
        }
        const result = simulate(config);
        return sendJson(res, result.ok ? 200 : 422, result);
      } catch (err) {
        return sendJson(res, 500, { ok: false, errors: [{ code: 'INTERNAL', message: String(err?.message || err) }] });
      }
    }
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405);
    res.end('method not allowed');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`[server] 惯性延迟复核服务监听 http://${HOST}:${PORT}（健康检查 /health）`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
