// Load the catalog + approved aliases from the database into the shapes the
// Matcher and aggregator need. Used by both prod and local handlers.

import type { DB } from './db.ts';
import type { Catalog } from './types.ts';
import type { Alias } from './matcher.ts';

export interface LoadedCatalog {
  catalog: Catalog;
  aliases: Alias[];
  songSeries: Map<string, number[]>;
  allSongIds: string[];
  released: Map<string, string>;
}

/** event_id → set of song ids (the leg's setlist union) for event-scope eligibility. */
export async function loadEventSongs(db: DB): Promise<Map<string, Set<string>>> {
  const rows = await db.all<{ event_id: string; song_id: string }>('SELECT event_id, song_id FROM event_song');
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!m.has(r.event_id)) m.set(r.event_id, new Set());
    m.get(r.event_id)!.add(r.song_id);
  }
  return m;
}

export async function loadCatalogFromDb(db: DB): Promise<LoadedCatalog> {
  const [songs, artists, series, aliasRows] = await Promise.all([
    db.all<{ id: string; name_jp: string; name_en: string | null; phonetic: string | null; series_ids: string; released_on: string | null; artist_ids: string | null }>(
      'SELECT id, name_jp, name_en, phonetic, series_ids, released_on, artist_ids FROM song',
    ),
    db.all<{ id: string; name_jp: string; name_en: string | null }>('SELECT id, name_jp, name_en FROM artist'),
    db.all<{ id: string; name_jp: string; color: string | null }>('SELECT id, name_jp, color FROM series'),
    db.all<{ song_id: string; norm_key: string }>("SELECT song_id, norm_key FROM song_alias WHERE approved = 1"),
  ]);

  const songSeries = new Map<string, number[]>();
  const released = new Map<string, string>();
  const catalogSongs = songs.map((s) => {
    const seriesIds = JSON.parse(s.series_ids || '[]') as number[];
    songSeries.set(s.id, seriesIds);
    if (s.released_on) released.set(s.id, s.released_on);
    return {
      id: s.id,
      name: s.name_jp,
      englishName: s.name_en ?? undefined,
      phoneticName: s.phonetic ?? undefined,
      seriesIds,
      artistIds: JSON.parse(s.artist_ids || '[]') as string[],
    };
  });

  return {
    catalog: {
      songs: catalogSongs,
      artists: artists.map((a) => ({ id: a.id, name: a.name_jp, englishName: a.name_en ?? undefined })),
      series: series.map((s) => ({ id: s.id, name: s.name_jp, color: s.color ?? undefined })),
    },
    aliases: aliasRows.map((a) => ({ songId: a.song_id, normKey: a.norm_key })),
    songSeries,
    allSongIds: catalogSongs.map((s) => s.id),
    released,
  };
}
