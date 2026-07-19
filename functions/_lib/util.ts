// Helpers shared by the Pages Functions wrappers.
import { d1Adapter } from '../../src/db-d1.ts';
import { HttpError } from '../../src/handlers.ts';
import type { DB } from '../../src/db.ts';

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
}

export function db(env: Env): DB {
  return d1Adapter(env.DB);
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}

export async function guard(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await fn());
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message ?? 'internal error' }, 500);
  }
}

/** Coarse anonymous fingerprint (hashed IP + UA) for rate limiting / dedupe. */
export function fingerprint(request: Request): string {
  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
  const ua = request.headers.get('user-agent') ?? '';
  let h = 5381;
  const s = ip + '|' + ua;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'fp_' + (h >>> 0).toString(16);
}
