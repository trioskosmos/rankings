// Shared domain types for the rankings app.

export interface CatalogSong {
  id: string;
  name: string;
  englishName?: string;
  phoneticName?: string;
  seriesIds: number[];
  artistIds: string[]; // resolved artist ids (from artists[].id)
  art?: string; // album-art URL (from discography)
}

export interface CatalogArtist {
  id: string;
  name: string;
  englishName?: string;
}

export interface CatalogSeries {
  id: string;
  name: string;
  color?: string;
}

export interface Catalog {
  songs: CatalogSong[];
  artists: CatalogArtist[];
  series: CatalogSeries[];
}

/** A single parsed line from a pasted/uploaded ranking. */
export interface ParsedItem {
  position: number;
  songText: string;
  artistText: string | null;
  rawLine: string;
}

/** A parsed ranking = header (ranker) + ordered items. */
export interface ParsedRanking {
  rankerName: string;
  items: ParsedItem[];
}

export type MatchVia = 'name' | 'romaji' | 'alias' | 'fuzzy' | 'manual' | 'none';
export type MatchState = 'matched' | 'ambiguous' | 'unmatched';

export interface Candidate {
  songId: string;
  name: string;
  englishName?: string;
  artist: string;
  series: string;
  score: number;
}

/** Result of matching one parsed line against the catalog. */
export interface MatchResult {
  position: number;
  rawLine: string;
  songText: string;
  artistText: string | null;
  state: MatchState;
  songId: string | null;
  via: MatchVia;
  score: number;
  candidates: Candidate[];
}

export type ScopeType = 'all' | 'series' | 'event' | 'performance' | 'custom';
