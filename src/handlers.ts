// Shared API handlers. Adapter-agnostic (take a DB) so both the Cloudflare
// Pages Functions and the local Bun dev server call the exact same logic.

import type { DB } from './db.ts';
import { loadCatalogFromDb, loadEventSongs } from './catalog-db.ts';
import { Matcher } from './matcher.ts';
import { parseRankings } from './parse.ts';
import { normalizeKey } from './normalize.ts';
import { computeAggregate, type AggRanking } from './aggregate.ts';
import type { ScopeType } from './types.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const RATE_LIMIT = 10; // submissions per IP per hour

// ---------- catalog (for the submit-page song picker) ----------
export async function handleCatalog(db: DB) {
  const { catalog, released } = await loadCatalogFromDb(db);
  const seriesName = new Map(catalog.series.map((s) => [s.id, s.name]));
  const seriesColor = new Map(catalog.series.map((s) => [s.id, s.color]));
  const artistName = new Map(catalog.artists.map((a) => [a.id, a.name]));
  return {
    series: catalog.series,
    songs: catalog.songs.map((s) => ({
      id: s.id,
      name: s.name,
      en: s.englishName ?? '',
      artist: s.artistIds.map((id) => artistName.get(id)).filter(Boolean).join(', ') || 'Unknown',
      series: s.seriesIds.map((id) => seriesName.get(String(id))).filter(Boolean).join(', ') || 'Unknown',
      color: seriesColor.get(String(s.seriesIds[0])) || '#888',
      date: released.get(s.id) ?? '',
      art: s.art ?? '',
    })),
  };
}

// ---------- events (concert legs, for the submit-page picker) ----------
export async function handleEvents(db: DB, q = '') {
  const tokens = q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  // each token must appear in tour_name|name|venue (token-AND across fields)
  const where = tokens.map(() => '(e.tour_name LIKE ? OR e.name LIKE ? OR e.venue LIKE ?)').join(' AND ') || '1=1';
  const params = tokens.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);
  const rows = await db.all(
    `SELECT e.id, e.tour_name, e.name, e.venue, e.series_ids, e.date_start, e.date_end, e.day_count,
            (SELECT COUNT(*) FROM event_song es WHERE es.event_id = e.id) AS song_count
     FROM event e WHERE ${where}
     ORDER BY e.date_start DESC LIMIT 1000`,
    ...params,
  );
  return { events: rows };
}

// song ids of one leg (for the "sort in the-sorter" deep link)
export async function handleEventSongs(db: DB, id: string) {
  const ev = await db.first<{ id: string; tour_name: string; name: string; perf_ids: string | null }>(
    'SELECT id, tour_name, name, perf_ids FROM event WHERE id = ?',
    id,
  );
  if (!ev) throw new HttpError(404, 'unknown event');
  const rows = await db.all<{ song_id: string }>(
    'SELECT song_id FROM event_song WHERE event_id = ? ORDER BY CAST(song_id AS INTEGER)',
    id,
  );
  return {
    event: { id: ev.id, tour_name: ev.tour_name, name: ev.name },
    songIds: rows.map((r) => r.song_id),
    perfIds: JSON.parse(ev.perf_ids || '[]') as string[],
  };
}

// ---------- parse + match (no write) ----------
export async function handleParse(db: DB, body: { text?: string }) {
  const text = (body.text ?? '').toString();
  if (!text.trim()) throw new HttpError(400, 'empty text');
  const { catalog, aliases } = await loadCatalogFromDb(db);
  const matcher = new Matcher(catalog, aliases);
  const parsed = parseRankings(text);
  if (!parsed.length) throw new HttpError(400, 'no rankings found');
  const first = parsed[0];
  const items = first.items.map((it) => matcher.match(it));
  return {
    rankerName: first.rankerName === 'unknown' ? '' : first.rankerName,
    extraRankings: parsed.length - 1,
    counts: {
      total: items.length,
      matched: items.filter((i) => i.state === 'matched').length,
      ambiguous: items.filter((i) => i.state === 'ambiguous').length,
      unmatched: items.filter((i) => i.state === 'unmatched').length,
    },
    items,
  };
}

// ---------- create pending ranking (the submit) ----------
interface CreateItem {
  position: number;
  songId: string | null;
  customName: string | null;
  rawLine: string;
  via?: string;
  score?: number;
  aliasText?: string | null; // if user manually mapped a free-text → songId
}
export async function handleCreateRanking(
  db: DB,
  body: {
    rankerName?: string;
    title?: string;
    scopeType?: ScopeType;
    scopeRef?: string | null;
    items?: CreateItem[];
  },
  fp: string,
  requireApproval = false, // when false, submissions go live immediately (no admin approval)
) {
  const rankerName = (body.rankerName ?? '').trim();
  if (!rankerName) throw new HttpError(400, 'ranker name required');
  const items = (body.items ?? []).filter((i) => i.songId || i.customName);
  const resolved = items.filter((i) => i.songId).length;
  if (resolved < 5) throw new HttpError(400, 'need at least 5 matched songs');

  // rate limit (guest-only abuse control)
  const nowIso = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await db.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM submit_rate WHERE fp = ? AND at > ?',
    fp,
    hourAgo,
  );
  if ((recent?.n ?? 0) >= RATE_LIMIT) throw new HttpError(429, 'rate limit exceeded, try later');

  const scopeType = (body.scopeType ?? 'custom') as ScopeType;
  // series + event carry a scope_ref (series id / concert-leg id); validate events.
  const scopeRef = scopeType === 'series' || scopeType === 'event' ? body.scopeRef ?? null : null;
  if (scopeType === 'event') {
    if (!scopeRef) throw new HttpError(400, 'event scope requires an event');
    const ev = await db.first('SELECT id FROM event WHERE id = ?', scopeRef);
    if (!ev) throw new HttpError(400, 'unknown event');
  }
  const status = requireApproval ? 'pending' : 'approved';
  const ins = await db.run(
    "INSERT INTO ranking (title, ranker_name, source, scope_type, scope_ref, status, created_at, submitter_fp, reviewed_at, reviewed_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
    body.title ?? null,
    rankerName,
    'web',
    scopeType,
    scopeRef,
    status,
    nowIso,
    fp,
    requireApproval ? null : nowIso,
    requireApproval ? null : 'auto',
  );
  const rankingId = ins.lastRowId;
  if (!rankingId) throw new HttpError(500, 'insert failed');

  let pos = 0;
  for (const it of items) {
    pos++;
    await db.run(
      'INSERT INTO ranking_item (ranking_id, position, song_id, custom_name, raw_line, match_via, match_score) VALUES (?,?,?,?,?,?,?)',
      rankingId,
      pos,
      it.songId ?? null,
      it.songId ? null : it.customName,
      it.rawLine ?? it.customName ?? '',
      it.via ?? (it.songId ? 'manual' : 'none'),
      it.score ?? null,
    );
    // learned alias from a manual correction
    if (it.songId && it.aliasText) {
      const norm = normalizeKey(it.aliasText);
      if (norm)
        await db.run(
          'INSERT INTO song_alias (song_id, alias_text, norm_key, approved, created_at) VALUES (?,?,?,?,?)',
          it.songId,
          it.aliasText,
          norm,
          requireApproval ? 0 : 1, // auto-approved submissions also commit their aliases
          nowIso,
        );
    }
  }
  await db.run('INSERT INTO submit_rate (fp, at) VALUES (?,?)', fp, nowIso);
  if (!requireApproval)
    await db.run(
      'INSERT INTO moderation_event (ranking_id, action, actor, created_at) VALUES (?,?,?,?)',
      rankingId,
      'auto_approve',
      'auto',
      nowIso,
    );
  return { id: rankingId, status };
}

// ---------- read: rankings list with resolved song ids ----------
export async function handleListRankings(db: DB, status = 'approved') {
  const rankings = await db.all<{
    id: number;
    title: string | null;
    ranker_name: string;
    source: string;
    scope_type: string;
    scope_ref: string | null;
  }>(
    'SELECT id, title, ranker_name, source, scope_type, scope_ref FROM ranking WHERE status = ? ORDER BY id',
    status,
  );
  const items = await db.all<{ ranking_id: number; song_id: string }>(
    `SELECT ri.ranking_id, ri.song_id FROM ranking_item ri
     JOIN ranking r ON r.id = ri.ranking_id
     WHERE r.status = ? AND ri.song_id IS NOT NULL ORDER BY ri.ranking_id, ri.position`,
    status,
  );
  const byRanking = new Map<number, string[]>();
  for (const it of items) {
    if (!byRanking.has(it.ranking_id)) byRanking.set(it.ranking_id, []);
    byRanking.get(it.ranking_id)!.push(it.song_id);
  }
  return {
    rankings: rankings.map((r) => ({
      id: r.id,
      title: r.title,
      rankerName: r.ranker_name,
      source: r.source,
      scopeType: r.scope_type,
      scopeRef: r.scope_ref,
      songIds: byRanking.get(r.id) ?? [],
    })),
  };
}

// ---------- read: single ranking ----------
export async function handleGetRanking(db: DB, id: number) {
  const r = await db.first('SELECT * FROM ranking WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'not found');
  const items = await db.all(
    `SELECT ri.position, ri.song_id, ri.custom_name, ri.raw_line, s.name_jp AS name, s.name_en AS en
     FROM ranking_item ri LEFT JOIN song s ON s.id = ri.song_id
     WHERE ri.ranking_id = ? ORDER BY ri.position`,
    id,
  );
  return { ranking: r, items };
}

// ---------- aggregate ----------
// opts.event = <concertId> restricts to that leg's rankings (apples-to-apples
// across attendees of the same show).
export async function handleAggregate(db: DB, opts: { event?: string } = {}) {
  const { songSeries, allSongIds } = await loadCatalogFromDb(db);
  const eventSongs = await loadEventSongs(db);
  const { rankings } = await handleListRankings(db, 'approved');
  let selected = rankings;
  if (opts.event) selected = rankings.filter((r) => r.scopeType === 'event' && String(r.scopeRef) === String(opts.event));
  const agg: AggRanking[] = selected.map((r) => ({
    scopeType: r.scopeType as AggRanking['scopeType'],
    scopeRef: r.scopeRef,
    songIds: r.songIds,
  }));
  const stats = computeAggregate(agg, songSeries, allSongIds, eventSongs);
  return { totalRankings: selected.length, event: opts.event ?? null, stats };
}

// ---------- admin ----------
function requireAdmin(token: string | null, expected: string) {
  if (!token || token !== expected) throw new HttpError(403, 'forbidden');
}

export async function handleAdminPending(db: DB, token: string | null, expected: string) {
  requireAdmin(token, expected);
  const rankings = await db.all(
    `SELECT r.id, r.title, r.ranker_name, r.scope_type, r.scope_ref, r.created_at, r.note,
            (SELECT COUNT(*) FROM ranking_item ri WHERE ri.ranking_id = r.id) AS item_count,
            (SELECT COUNT(*) FROM ranking_item ri WHERE ri.ranking_id = r.id AND ri.song_id IS NOT NULL) AS matched_count
     FROM ranking r WHERE r.status = 'pending' ORDER BY r.created_at`,
  );
  return { rankings };
}

export async function handleModerate(
  db: DB,
  id: number,
  action: 'approve' | 'reject',
  token: string | null,
  expected: string,
) {
  requireAdmin(token, expected);
  const r = await db.first('SELECT id, status FROM ranking WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'not found');
  const nowIso = new Date().toISOString();
  const status = action === 'approve' ? 'approved' : 'rejected';
  await db.run('UPDATE ranking SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?', status, nowIso, 'admin', id);
  await db.run(
    'INSERT INTO moderation_event (ranking_id, action, actor, created_at) VALUES (?,?,?,?)',
    id,
    action,
    'admin',
    nowIso,
  );
  if (action === 'approve') {
    // approve the aliases this ranking taught (any pending aliases for its songs)
    await db.run(
      `UPDATE song_alias SET approved = 1 WHERE approved = 0 AND song_id IN (SELECT song_id FROM ranking_item WHERE ranking_id = ? AND song_id IS NOT NULL)`,
      id,
    );
  }
  return { id, status };
}
