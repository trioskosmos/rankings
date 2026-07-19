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
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const PORT = Number(process.env.PORT ?? 8788);

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
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---- API ----
    if (p.startsWith('/api/')) {
      const token = req.headers.get('x-admin-token');
      if (p === '/api/catalog' && req.method === 'GET') return guard(() => H.handleCatalog(db));
      if (p === '/api/aggregate' && req.method === 'GET') return guard(() => H.handleAggregate(db));
      if (p === '/api/import/parse' && req.method === 'POST')
        return guard(async () => H.handleParse(db, (await req.json()) as { text?: string }));
      if (p === '/api/rankings' && req.method === 'GET')
        return guard(() => H.handleListRankings(db, url.searchParams.get('status') ?? 'approved'));
      if (p === '/api/rankings' && req.method === 'POST')
        return guard(async () => H.handleCreateRanking(db, (await req.json()) as Parameters<typeof H.handleCreateRanking>[1], fp(req)));
      let m = p.match(/^\/api\/rankings\/(\d+)$/);
      if (m && req.method === 'GET') return guard(() => H.handleGetRanking(db, Number(m![1])));
      if (p === '/api/admin/pending' && req.method === 'GET')
        return guard(() => H.handleAdminPending(db, token, ADMIN_TOKEN));
      m = p.match(/^\/api\/admin\/rankings\/(\d+)$/);
      if (m && req.method === 'POST')
        return guard(async () => {
          const body = (await req.json()) as { action?: 'approve' | 'reject' };
          return H.handleModerate(db, Number(m![1]), body.action === 'reject' ? 'reject' : 'approve', token, ADMIN_TOKEN);
        });
      return json({ error: 'not found' }, 404);
    }

    // ---- static ----
    let file = p === '/' ? '/index.html' : p;
    if (file.includes('..')) return new Response('bad path', { status: 400 });
    const f = Bun.file(join(root, file));
    if (await f.exists()) return new Response(f);
    return new Response('not found', { status: 404 });
  },
});

console.log(`rankings dev server → http://localhost:${PORT}  (admin token: ${ADMIN_TOKEN})`);
