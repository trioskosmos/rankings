// Load the canonical catalog from the local data/*.json files (Node/Bun only —
// used by build scripts, NOT by Workers, which read the catalog from D1).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Catalog } from './types.ts';

interface RawSong {
  id: string;
  name: string;
  englishName?: string;
  phoneticName?: string;
  seriesIds?: number[];
  artists?: { id: string; variant: string | null }[];
  releasedOn?: string;
}
interface RawArtist {
  id: string;
  name: string;
  englishName?: string;
}
interface RawSeries {
  id: string;
  name: string;
  color?: string;
}

export function loadCatalogFromFs(dataDir: string): Catalog & { released: Map<string, string> } {
  const read = <T>(f: string): T => JSON.parse(readFileSync(join(dataDir, f), 'utf8')) as T;
  const rawSongs = read<RawSong[]>('song-info.json');
  const rawArtists = read<RawArtist[]>('artists-info.json');
  const rawSeries = read<RawSeries[]>('series-info.json');

  const released = new Map<string, string>();
  const songs = rawSongs.map((s) => {
    if (s.releasedOn) released.set(s.id, s.releasedOn);
    return {
      id: String(s.id),
      name: s.name,
      englishName: s.englishName,
      phoneticName: s.phoneticName,
      seriesIds: s.seriesIds ?? [],
      artistIds: [...new Set((s.artists ?? []).map((a) => String(a.id)))],
    };
  });
  const artists = rawArtists.map((a) => ({ id: String(a.id), name: a.name, englishName: a.englishName }));
  const series = rawSeries.map((s) => ({ id: String(s.id), name: s.name, color: s.color }));
  return { songs, artists, series, released };
}
