-- Rankings app — D1 (SQLite) schema.
-- Idempotent: safe to re-run. See docs/import-redesign-spec.md §4.

-- ---------- Canonical catalog (synced from the-sorter / ll-sorter-scripts) ----------
CREATE TABLE IF NOT EXISTS series (
  id       TEXT PRIMARY KEY,
  name_jp  TEXT NOT NULL,
  name_en  TEXT,
  color    TEXT
);

CREATE TABLE IF NOT EXISTS artist (
  id         TEXT PRIMARY KEY,
  name_jp    TEXT NOT NULL,
  name_en    TEXT,
  series_ids TEXT            -- JSON array
);

CREATE TABLE IF NOT EXISTS song (
  id          TEXT PRIMARY KEY,
  name_jp     TEXT NOT NULL,
  name_en     TEXT,
  phonetic    TEXT,
  series_ids  TEXT NOT NULL, -- JSON array
  released_on TEXT,
  artist_ids  TEXT,          -- JSON array of artist id strings
  art_url     TEXT           -- album-art URL (from discography)
);

-- Precomputed normalized match keys; song_id NULL means the key collides across
-- >1 song (null-on-collision → never guess wrong).
CREATE TABLE IF NOT EXISTS song_match_key (
  key     TEXT NOT NULL,
  source  TEXT NOT NULL,      -- 'name'|'en'|'phonetic'|'romaji'|'alias'
  song_id TEXT,
  PRIMARY KEY (key, source)
);
CREATE INDEX IF NOT EXISTS idx_song_match_key ON song_match_key(key);

-- Concert "legs" (an event = all performances sharing a concertId, e.g. Day.1+Day.2).
CREATE TABLE IF NOT EXISTS event (
  id          TEXT PRIMARY KEY,          -- concertId
  tour_name   TEXT,
  name        TEXT,                        -- leg name (Day.x stripped)
  venue       TEXT,
  series_ids  TEXT,                        -- JSON array
  date_start  TEXT,
  date_end    TEXT,
  day_count   INTEGER,
  perf_ids    TEXT,                        -- JSON array of day performanceIds (for the-sorter deep link)
  slug        TEXT                         -- grouping slug, e.g. "hasu6th" ({series}{ordinal})
);

-- The song universe of a leg = union of its days' setlists (eligibility for event scope).
CREATE TABLE IF NOT EXISTS event_song (
  event_id TEXT NOT NULL,
  song_id  TEXT NOT NULL,
  PRIMARY KEY (event_id, song_id)
);
CREATE INDEX IF NOT EXISTS idx_event_song_event ON event_song(event_id);

-- Learned aliases from confirmed imports (fills the missing-aliases gap).
CREATE TABLE IF NOT EXISTS song_alias (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id    TEXT NOT NULL,
  alias_text TEXT NOT NULL,
  norm_key   TEXT NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_song_alias_norm ON song_alias(norm_key);

-- ---------- Rankings (the write path) ----------
CREATE TABLE IF NOT EXISTS ranking (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT,
  ranker_name  TEXT NOT NULL,
  source       TEXT NOT NULL,             -- 'web' | 'legacy'
  scope_type   TEXT NOT NULL DEFAULT 'custom', -- 'all'|'series'|'event'|'custom'
  scope_ref    TEXT,
  note         TEXT,
  submitter_fp TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ranking_item (
  ranking_id  INTEGER NOT NULL,
  position    INTEGER NOT NULL,
  song_id     TEXT,
  custom_name TEXT,
  raw_line    TEXT NOT NULL,
  match_via   TEXT,
  match_score REAL,
  PRIMARY KEY (ranking_id, position)
);
CREATE INDEX IF NOT EXISTS idx_ranking_item_song ON ranking_item(song_id);

-- Coarse per-IP submit rate log (abuse control).
CREATE TABLE IF NOT EXISTS submit_rate (
  fp TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submit_rate_fp ON submit_rate(fp);
