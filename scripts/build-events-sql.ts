// Generate schema/seed-events.sql: concert "legs" (grouped by concertId) and the
// union of each leg's setlist songs, from performance-info + performance-setlists.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));
const perf = read('performance-info.json') as any[];
const sets = read('performance-setlists.json') as Record<string, any>;

const q = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

// group performances by concertId
const legs = new Map<string, any[]>();
for (const p of perf) {
  if (!p.concertId) continue;
  const k = String(p.concertId);
  if (!legs.has(k)) legs.set(k, []);
  legs.get(k)!.push(p);
}

// Short series codes for the grouping slug (see index.html "File:" filter).
const SERIES_SHORT: Record<string, string> = {
  '1': 'muse',
  '2': 'aqours',
  '3': 'nijigasaki',
  '4': 'liella',
  '5': 'musical',
  '6': 'hasu',
  '7': 'yohane',
  '8': 'bluebird',
};
// City tokens (from each leg's "〇〇公演" name) → romaji, for per-leg slugs. No
// venue names. Order matters: longer/more-specific keys first.
const CITY: Record<string, string> = {
  北海道: 'hokkaido', 名古屋: 'nagoya', 神奈川: 'kanagawa', 東京: 'tokyo', 大阪: 'osaka', 福岡: 'fukuoka',
  愛知: 'aichi', 千葉: 'chiba', 宮城: 'miyagi', 埼玉: 'saitama', 広島: 'hiroshima', 横浜: 'yokohama',
  兵庫: 'hyogo', 札幌: 'sapporo', 沼津: 'numazu', 神戸: 'kobe', 松山: 'matsuyama', 仙台: 'sendai',
  金沢: 'kanazawa', 旭川: 'asahikawa', 長野: 'nagano', 群馬: 'gunma', 岡山: 'okayama', 福井: 'fukui',
  石川: 'ishikawa', 新潟: 'niigata', 広州: 'guangzhou', 上海: 'shanghai', 台北: 'taipei', ソウル: 'seoul',
};
const detectCity = (names: string[]): string => {
  const hay = names.join(' ');
  for (const [jp, romaji] of Object.entries(CITY)) if (hay.includes(jp)) return romaji;
  return '';
};
// Slug base = {series}{ordinal}{city}, e.g. "hasu6thsaitama". {series}{year} when
// no ordinal. Uniqueness (city missing / collisions) is resolved after the loop.
function slugBase(tourName: string, seriesIds: string[], dateStart: string | undefined, names: string[]) {
  const short = SERIES_SHORT[seriesIds[0]] ?? 's' + (seriesIds[0] ?? '');
  const ord = (tourName.match(/(\d+)(st|nd|rd|th)/i)?.[0] ?? '').toLowerCase();
  const city = detectCity(names);
  const base = (short + (ord || (dateStart ?? '').slice(0, 4)) + city).replace(/[^a-z0-9]/g, '') || short;
  return { base, hasCity: !!city };
}

const stripDay = (name: string | undefined): string =>
  (name ?? '').replace(/[\s（(]*(Day|DAY)[\s.]*\.?\s*\d+.*$/i, '').replace(/[\s（(]*(昼公演|夜公演).*$/, '').trim();

const setlistSongs = (perfId: string): string[] => {
  const sl = sets[perfId];
  const items = sl?.items ?? sl?.songs ?? [];
  return items.filter((i: any) => (i.type === 'song' || i.songId) && i.songId).map((i: any) => String(i.songId));
};

const eventRows: string[][] = [];
const eventSongRows: string[][] = [];
const slugMeta: { concertId: string; base: string; hasCity: boolean }[] = []; // parallel to eventRows
let legCount = 0,
  songLinks = 0;

for (const [concertId, days] of legs) {
  const union = new Set<string>();
  const perfIds: string[] = []; // day performanceIds that have a setlist (for the-sorter deep link)
  for (const d of days) {
    const songs = setlistSongs(String(d.id));
    if (songs.length) perfIds.push(String(d.id));
    songs.forEach((s) => union.add(s));
  }
  if (!perfIds.length || union.size === 0) continue; // only legs with real setlists
  legCount++;
  const dates = days.map((d) => d.date).filter(Boolean).sort();
  const seriesIds = [...new Set(days.flatMap((d) => (d.seriesIds ?? []).map(String)))];
  const first = days[0];
  const names = days.map((d) => d.performanceName ?? d.concertName ?? '');
  const { base, hasCity } = slugBase(first.tourName, seriesIds, dates[0], names);
  slugMeta.push({ concertId: String(concertId), base, hasCity });
  eventRows.push([
    q(concertId),
    q(first.tourName),
    q(stripDay(first.performanceName ?? first.concertName) || first.tourName),
    q(first.venue),
    q(JSON.stringify(seriesIds)),
    q(dates[0]),
    q(dates[dates.length - 1]),
    String(days.length),
    q(JSON.stringify(perfIds)),
    'SLUG_PLACEHOLDER', // finalized below
  ]);
  for (const songId of union) {
    eventSongRows.push([q(concertId), q(songId)]);
    songLinks++;
  }
}

// Finalize per-leg unique slugs: use the clean {series}{ordinal}{city} base when
// it's unique and has a city; otherwise append the concertId to guarantee
// uniqueness (each leg gets its own slug).
const baseCount = new Map<string, number>();
for (const m of slugMeta) baseCount.set(m.base, (baseCount.get(m.base) ?? 0) + 1);
slugMeta.forEach((m, i) => {
  const clean = m.hasCity && baseCount.get(m.base) === 1;
  const slug = clean ? m.base : `${m.base}-${m.concertId}`;
  eventRows[i][eventRows[i].length - 1] = q(slug);
});

function batch(table: string, cols: string[], rows: string[][]): string {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += 100)
    out.push(
      `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES\n` +
        rows.slice(i, i + 100).map((r) => `  (${r.join(', ')})`).join(',\n') +
        ';',
    );
  return out.join('\n');
}

const sql = [
  '-- Generated by scripts/build-events-sql.ts',
  'DELETE FROM event; DELETE FROM event_song;',
  batch('event', ['id', 'tour_name', 'name', 'venue', 'series_ids', 'date_start', 'date_end', 'day_count', 'perf_ids', 'slug'], eventRows),
  batch('event_song', ['event_id', 'song_id'], eventSongRows),
  '',
].join('\n\n');

writeFileSync(join(root, 'schema', 'seed-events.sql'), sql);
console.log(`Wrote schema/seed-events.sql: ${legCount} events (legs), ${songLinks} event-song links`);
