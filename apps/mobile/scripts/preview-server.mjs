import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Development-only Vite middleware; authorization and account isolation stay server-side. */
export class PreviewServer {
 static actions = new Set(['state', 'bind', 'save', 'delete', 'sync', 'reset', 'draft', 'render', 'keyboard', 'keyboard_render', 'asset', 'asset_import', 'asset_fetch', 'recovery', 'resolve']);
 static queues = new Map();
 static plugin() {
  return { name: 'typerelay-mobile-preview', configureServer(server) {
   server.middlewares.use((req, res, next) => {
    const base = new URL(process.env.MOBILE_PREVIEW_ORIGIN || 'http://localhost:5174').pathname.replace(/\/$/, '');
    const pathname = new URL(req.url, 'http://preview').pathname;
    const path = base && pathname.startsWith(base + '/') ? pathname.slice(base.length) : pathname;
    if (!path.startsWith('/__preview/') && path !== '/assets/generated/template.wasm') return next();
    PreviewServer.handle(req, res, path).catch(error => PreviewServer.json(res, error.status || 500, { error: error.message || 'Preview request failed' }));
   });
  } };
 }
 static json(res, status, data) { if (res.headersSent) return; res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
 static async body(req) { let length = 0; const chunks = []; for await (const chunk of req) { length += chunk.length; if (length > 12 * 1048576) throw Object.assign(new Error('Request too large'), { status: 413 }); chunks.push(chunk); } return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; }
 static backend() { return process.env.MOBILE_API_URL || 'http://app:3040'; }
 static async handle(req, res, path) {
  if (path === '/assets/generated/template.wasm') { res.setHeader('Content-Type', 'application/wasm'); res.end(await readFile('/usr/local/share/typerelay/template.wasm')); return; }
  if (req.headers.origin && req.headers.origin !== new URL(process.env.MOBILE_PREVIEW_ORIGIN).origin) return PreviewServer.json(res, 403, { error: 'Invalid preview origin' });
  if (path.startsWith('/__preview/api/')) {
   const target = path.slice('/__preview/api'.length);
   if (target !== '/oauth/token' && !target.startsWith('/api/v2/')) return PreviewServer.json(res, 404, { error: 'Unknown preview API' });
   const response = await fetch(PreviewServer.backend() + target, { method: req.method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-TypeRelay-Sync-Protocol': '6', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) }, ...(!['GET','HEAD'].includes(req.method) ? { body: JSON.stringify(await PreviewServer.body(req)) } : {}) });
   return PreviewServer.json(res, response.status, await response.json().catch(() => ({ error: 'Backend request failed' })));
  }
  if (path !== '/__preview/native' || req.method !== 'POST') return PreviewServer.json(res, 404, { error: 'Unknown preview route' });
  if (!req.headers.authorization?.startsWith('Bearer ')) return PreviewServer.json(res, 401, { error: 'Sign in first' });
  const identityResponse = await fetch(PreviewServer.backend() + '/api/v2/mobile-preview/identity', { redirect: 'manual', headers: { Authorization: req.headers.authorization, 'X-TypeRelay-Sync-Protocol': '6' } });
  if (!identityResponse.ok) return PreviewServer.json(res, identityResponse.status, { error: 'Preview sign-in expired' });
  const identity = await identityResponse.json();
  const client = req.headers['x-preview-client'];
  if (typeof client !== 'string' || !/^[a-f0-9-]{36}$/.test(client)) return PreviewServer.json(res, 400, { error: 'Invalid preview session' });
  const request = await PreviewServer.body(req);
  if (!PreviewServer.actions.has(request.action)) return PreviewServer.json(res, 400, { error: 'Unknown mobile action' });
  // Neither file paths nor API credentials/origins are accepted from request JSON.
  delete request.server; delete request.account; delete request.access_token;
  if (request.action === 'bind') { request.server = process.env.MOBILE_API_ORIGIN; request.account = identity.account; }
  if (['sync', 'asset_fetch'].includes(request.action)) { request.server = PreviewServer.backend(); request.access_token = req.headers.authorization.slice(7); }
  const key = createHash('sha256').update(JSON.stringify([identity.user, identity.account, client])).digest('hex');
  const root = join('/data/mobile-preview', key);
  const previous = PreviewServer.queues.get(key) || Promise.resolve();
  const job = previous.catch(() => undefined).then(() => PreviewServer.execute(root, request));
  PreviewServer.queues.set(key, job);
  try { const result = await job; PreviewServer.json(res, result.error ? result.status || 400 : 200, result); }
  finally { if (PreviewServer.queues.get(key) === job) PreviewServer.queues.delete(key); }
 }
 static execute(root, request) {
  return new Promise((resolve, reject) => {
   const process = execFile('/usr/local/bin/typerelay-mobile-preview', [join(root, 'private'), join(root, 'keyboard')], { timeout: 120000, maxBuffer: 64 * 1048576 }, (error, stdout) => { if (error) reject(new Error('Mobile storage operation failed')); else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid storage response')); } } });
   process.stdin.end(JSON.stringify(request));
  });
 }
}
