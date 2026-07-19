// Local dev server: serves the static pages + the /api/* endpoints backed by a
// local bun:sqlite database, using the SAME handlers as the Cloudflare Functions.
//
//   bun run scripts/dev-server.ts   →  http://localhost:8788
//
// Requires local.db to exist (run: bun run scripts/local-setup.ts).

import { Database } from 'bun:sqlite';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bunAdapter } from './db-bun.ts';
import { HttpError } from '../src/handlers.ts';
import * as H from '../src/handlers.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sqlite = new Database(join(root, 'local.db'));
const db = bunAdapter(sqlite);
const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? '127.0.0.1'; // IPv4 loopback — avoids IPv6-only bind issues

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

async function guard(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await fn());
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
}

function fp(req: Request): string {
  const ua = req.headers.get('user-agent') ?? '';
  let h = 5381;
  for (let i = 0; i < ua.length; i++) h = ((h << 5) + h + ua.charCodeAt(i)) | 0;
  return 'fp_' + (h >>> 0).toString(16);
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---- API ----
    if (p.startsWith('/api/')) {
      if (p === '/api/catalog' && req.method === 'GET') return guard(() => H.handleCatalog(db));
      if (p === '/api/events' && req.method === 'GET') return guard(() => H.handleEvents(db, url.searchParams.get('q') ?? ''));
      const em = p.match(/^\/api\/events\/([^/]+)$/);
      if (em && req.method === 'GET') return guard(() => H.handleEventSongs(db, decodeURIComponent(em[1])));
      if (p === '/api/aggregate' && req.method === 'GET')
        return guard(() => H.handleAggregate(db, { event: url.searchParams.get('event') ?? undefined }));
      if (p === '/api/import/parse' && req.method === 'POST')
        return guard(async () => H.handleParse(db, (await req.json()) as { text?: string }));
      if (p === '/api/rankings' && req.method === 'GET') return guard(() => H.handleListRankings(db));
      if (p === '/api/rankings' && req.method === 'POST')
        return guard(async () =>
          H.handleCreateRanking(db, (await req.json()) as Parameters<typeof H.handleCreateRanking>[1], fp(req)),
        );
      const m = p.match(/^\/api\/rankings\/(\d+)$/);
      if (m && req.method === 'GET') return guard(() => H.handleGetRanking(db, Number(m[1])));
      return json({ error: 'not found' }, 404);
    }

    // ---- static ----
    let file = p === '/' ? '/index.html' : p;
    if (file.includes('..')) return new Response('bad path', { status: 400 });
    const f = Bun.file(join(root, file));
    if (await f.exists()) {
      // Read into memory and return bytes rather than streaming Bun.file — the
      // streaming/sendfile path is denied (EPERM) under the macOS sandbox, which
      // makes static responses hang. A plain read is allowed.
      const buf = await f.arrayBuffer();
      return new Response(buf, {
        headers: { 'content-type': f.type || 'application/octet-stream', 'cache-control': 'no-store' },
      });
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`rankings dev server → http://${HOST}:${PORT}`);
