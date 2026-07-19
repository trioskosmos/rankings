# Rankings — Import Redesign & Storage Spec

**Status:** Implemented (v1) · **Owner:** trioskosmos · **Date:** 2026-07-18
**Scope:** Replace the "add a `.txt` via PR" ingestion with a direct web submit flow, redesign storage away from static text files, and fix cross-list aggregation of inconsistent song sets.

> **Implemented 2026-07-19.** Built to this spec: D1 schema (`schema/`), TS matcher +
> aggregation (`src/`), Cloudflare Pages Functions API (`functions/api/`), submit + admin pages,
> and a txt→DB backfill. Run locally with `bun run local:setup && bun run dev`. See `README.md`.
> Deferred from v1 (still design-only): the `aggregate_snapshot` cache (aggregation computes live
> instead), Copeland/pairwise metric (Borda shipped), Turnstile captcha (rate-limit shipped), and
> the scheduled catalog sync (§10, catalog is seeded from the committed JSON for now).

---

## 1. Problem statement

The `rankings` app aggregates Love Live! song rankings that fans produce in **the-sorter**
(`hamproductions.github.io/the-sorter`). Today:

1. **Ingestion is painful.** To add a ranking you commit a `.txt` file (`data/rankings/*.txt`) via
   PR, or "yell at trioskosmos." High friction, contributor-hostile, and gated on a maintainer.
2. **Storage is a pile of static text.** Each ranking is a free-text file: a header line (ranker
   name) followed by `N. 曲名 - アーティスト` lines. `index.html` fetches these **live from the
   GitHub Contents API** at render time (rate-limited, 1 request/file, no write path).
3. **Matching is naive and lossy.** `parseLine()` strips the number, **discards the ` - artist`
   suffix entirely**, then does exact-name match → substring `includes()` fallback. Misses are
   silently counted as `unr` and dropped. No romaji/phonetic support, no artist disambiguation,
   no collision safety.
4. **Lists rank different universes of songs.** One list ranks all ~600 songs, another ranks 40
   Hasunosora songs, another a 25-song concert setlist. The current aggregate treats "not in your
   list" as effectively tied-last within a file "pool" — apples-to-oranges, and it penalizes a song
   for being *out of scope* rather than *disliked*.

### Decisions locked (from interview, 2026-07-18)

| Question | Decision |
|---|---|
| Where does data live / how does submit persist? | **Serverless + hosted SQLite** (Cloudflare Pages + Functions + D1; Turso as alt) |
| Who can submit? | **Guest-only** (anonymous, no login) + **admin moderation queue** (pending → approved); rely on rate-limit + captcha |
| What "inconsistent songs" means | **Different song subsets per list** → aggregation-fairness is the core problem |
| Stack | **Lightweight standalone** — keep the vanilla HTML/JS front end; add a thin TS Worker + DB |
| Reuse `ll-predictions` **data/DB**? | **No — it doesn't hold what we need.** Its Postgres has **no catalog tables** (catalog is bundled JSON, identical to `rankings/data/`) and **no favorite-song rankings** (only concert *setlist predictions*). the-sorter has no DB either. So the `.txt` files remain the only persisted form of the ranking lists; dropping them requires our *own* store + a one-time import, not a read from ll-predictions. See §14. |

---

## 2. Goals / Non-goals

**Goals**
- A `/submit` page: paste text **or** upload a `.txt` → parsed into a ranking → user reviews &
  fixes matches → confirms → stored as **pending**.
- Robust free-text → canonical-song-ID matching (JP / romaji / English / phonetic), with artist
  disambiguation and a confirm-and-correct UI. No silent drops.
- Scalable storage in SQLite; the static text files stop being the source of truth.
- Fair aggregation across lists that rank **different subsets** of songs.
- A moderation queue so open submissions don't pollute the public aggregate.
- Keep the front end lightweight (vanilla JS); do the heavy matching server-side.

**Non-goals (v1)**
- User accounts / login (open submission + moderation instead).
- Re-implementing the-sorter's sorting UX (we ingest its output, not replace it).
- Editing the canonical song catalog here (the-sorter remains catalog source of truth; we sync).
- Real-time collaboration or per-user private lists.

---

## 3. Architecture overview

```
                         ┌───────────────────────────────────────────┐
                         │  Cloudflare Pages (static front end)        │
   Browser  ───────────► │  index.html (aggregate/rank/song/compare)   │
                         │  submit.html (paste/upload → confirm)        │
                         │  admin.html  (moderation queue)              │
                         └───────────────┬─────────────────────────────┘
                                         │  fetch /api/*
                         ┌───────────────▼─────────────────────────────┐
                         │  Pages Functions (TypeScript Worker)         │
                         │  • /api/import/parse   (match, no write)     │
                         │  • /api/rankings       (create pending)      │
                         │  • /api/rankings, /aggregate  (read)         │
                         │  • /api/admin/*        (approve/reject)      │
                         │  • matcher: ported resolveSongId + score     │
                         └───────────────┬─────────────────────────────┘
                                         │
                         ┌───────────────▼─────────────────────────────┐
                         │  D1 (SQLite)                                 │
                         │  song, song_alias, artist, series,          │
                         │  ranking, ranking_item, aggregate_snapshot, │
                         │  moderation_event                            │
                         └──────────────────────────────────────────────┘

   Catalog sync (scheduled/manual):  the-sorter / llernote  ──►  D1 catalog tables
```

**Why this shape**
- The front end stays vanilla and dumb; **matching runs in the Worker** (TypeScript), so we can
  directly port the-sorter/llernote matchers instead of rewriting them in plain JS.
- Cloudflare Pages replaces GitHub Pages (static hosting) *and* gives us Functions + D1 on one
  free-tier platform. Turso (libSQL) is the drop-in alternative if we'd rather keep hosting on
  GitHub Pages and hit Turso over HTTP from a standalone Worker.

---

## 4. Data model (SQLite / D1)

### 4.1 Canonical catalog (synced from the-sorter, read-mostly)

```sql
CREATE TABLE series (
  id          TEXT PRIMARY KEY,          -- "1".."8"
  name_jp     TEXT NOT NULL,
  name_en     TEXT,
  color       TEXT
);

CREATE TABLE artist (
  id          TEXT PRIMARY KEY,
  name_jp     TEXT NOT NULL,
  name_en     TEXT,
  series_ids  TEXT                        -- JSON array of series ids
);

CREATE TABLE song (
  id            TEXT PRIMARY KEY,         -- the-sorter Song.id (numeric string)
  name_jp       TEXT NOT NULL,            -- canonical JP title
  name_en       TEXT,                     -- englishName
  phonetic      TEXT,                     -- phoneticName (hiragana)
  series_ids    TEXT NOT NULL,            -- JSON array; length>1 = "cross" song
  released_on   TEXT,
  artist_ids    TEXT                      -- JSON array of {id, variant}
);

-- Precomputed normalized match keys, one row per (song, key). Powers exact-after-normalize
-- lookup with the-sorter's null-on-collision rule (see §5).
CREATE TABLE song_match_key (
  key         TEXT NOT NULL,             -- normalized(name|en|phonetic|romaji…)
  song_id     TEXT,                       -- NULL if this key collides across >1 song
  source      TEXT NOT NULL,             -- 'name'|'en'|'phonetic'|'romaji'|'alias'
  PRIMARY KEY (key, source)
);
CREATE INDEX idx_song_match_key ON song_match_key(key);

-- NEW: learned aliases. When a submitter manually maps a free-text line to a song in the
-- confirm UI, we persist it here so future imports match automatically. Fills the gap that
-- neither the-sorter nor llernote has an aliases field.
CREATE TABLE song_alias (
  id          INTEGER PRIMARY KEY,
  song_id     TEXT NOT NULL REFERENCES song(id),
  alias_text  TEXT NOT NULL,             -- raw text as typed by users
  norm_key    TEXT NOT NULL,             -- normalized form
  approved    INTEGER NOT NULL DEFAULT 0,-- aliases go through moderation too
  hits        INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_song_alias_norm ON song_alias(norm_key);
```

### 4.2 Rankings (the write path)

```sql
CREATE TABLE ranking (
  id            INTEGER PRIMARY KEY,
  title         TEXT,                      -- optional list title
  ranker_name   TEXT NOT NULL,            -- display name of the person ranking
  source        TEXT NOT NULL,            -- 'web' | 'txt-import' | 'legacy'
  scope_type    TEXT NOT NULL,            -- 'all' | 'series' | 'performance' | 'custom'
  scope_ref     TEXT,                      -- series_id / performance_id when applicable
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'approved'|'rejected'
  note          TEXT,
  submitter_fp  TEXT,                      -- coarse fingerprint (hashed IP+UA) for rate/dedupe
  created_at    TEXT NOT NULL,
  reviewed_at   TEXT,
  reviewed_by   TEXT
);
CREATE INDEX idx_ranking_status ON ranking(status);

CREATE TABLE ranking_item (
  ranking_id    INTEGER NOT NULL REFERENCES ranking(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,          -- 1-based rank
  song_id       TEXT REFERENCES song(id),  -- NULL if unresolved/custom
  custom_name   TEXT,                       -- free-text fallback (mirrors setlist customSongName)
  raw_line      TEXT NOT NULL,             -- exactly what the user submitted
  match_via     TEXT,                       -- 'name'|'romaji'|'alias'|'fuzzy'|'manual'|'none'
  match_score   REAL,                       -- 0..100 confidence at import time
  PRIMARY KEY (ranking_id, position)
);
CREATE INDEX idx_ranking_item_song ON ranking_item(song_id);

CREATE TABLE moderation_event (
  id          INTEGER PRIMARY KEY,
  ranking_id  INTEGER REFERENCES ranking(id),
  action      TEXT NOT NULL,               -- 'approve'|'reject'|'edit'|'alias_approve'
  actor       TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);

-- Precomputed aggregate to avoid heavy per-request compute (rebuilt on approve or on cron).
CREATE TABLE aggregate_snapshot (
  scope_key   TEXT NOT NULL,               -- e.g. 'all' | 'series:6' | 'perf:123'
  song_id     TEXT NOT NULL REFERENCES song(id),
  avg_norm    REAL,                         -- mean normalized rank (see §6)
  borda       REAL,                         -- Borda/Copeland consensus score
  median_pos  REAL,
  stddev      REAL,
  n_lists     INTEGER,                      -- how many eligible lists ranked it
  n_eligible  INTEGER,                      -- how many lists had it in-universe
  computed_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, song_id)
);
```

**Design notes**
- `ranking_item` keeps `raw_line` forever → fully auditable, re-matchable if the catalog improves.
- `song_id NULL + custom_name` is the graceful-degradation path, mirroring the-sorter/llernote's
  `customSongName`/`isCustomSong` convention. Unresolved songs are **kept**, not dropped.
- `scope_type/scope_ref` on the ranking is what makes fair aggregation possible (§6).

---

## 5. Matching pipeline (the core reuse)

Runs server-side in the Worker. Two entry points: **parse** (returns candidates for the confirm
UI, no write) and **resolve-on-confirm** (persists).

### 5.1 Parse

Improve on the current `parseLine`, keeping the artist half:

```
line: "12. 眩耀夜行 - スリーズブーケ"
  → position = 12
  → songText  = "眩耀夜行"
  → artistText = "スリーズブーケ"      # currently thrown away — we keep it
```
Header detection (ranker name) reuses the existing `isName()` heuristic (non-numbered, no ` - `).

### 5.2 Normalize + resolve (deterministic pass)

Port **the-sorter `src/utils/setlist-prediction/import.ts`** (`songNameMap` / `resolveSongId`):

1. Normalize: lowercase, strip everything outside `\p{L}\p{N}`, collapse/remove spaces.
2. Look up in `song_match_key` (built from `name`, `englishName`, `phoneticName`,
   `toRomaji(phoneticName)`, `toRomaji(toHiragana(englishName))`, plus approved `song_alias`).
3. **Null-on-collision:** if a normalized key maps to >1 song id, it resolves to *nothing* rather
   than guessing wrong. (Names are unique only *within* a series, so cross-series titles collide.)

### 5.3 Disambiguate with the artist half

When a song key is ambiguous/null, or a fuzzy match is uncertain, score `artistText` against
`artist.name_jp/name_en` and intersect candidates with each song's `artist_ids`. This is exactly
what resolves "same title, different unit" (e.g. `START:DASH!! - μ's` vs `START:DASH!! - Liella!`).

### 5.4 Fuzzy fallback + candidate ranking

For anything unresolved, run **llernote/the-sorter `getSearchScore`** (graded 0–100: exact JP 100,
exact EN 95, starts-with 90/85, contains 80/75, phonetic 70/65/60, Levenshtein `50-distance` with
length-tiered budget). Return the **top-N candidates per line** for the confirm UI.

### 5.5 Classification for the UI

| Result | UI state | Action |
|---|---|---|
| single confident match (score ≥ threshold, no collision) | 🟢 auto-matched | none |
| ambiguous / multiple candidates | 🟡 needs pick | dropdown of top-N (song + artist + series) |
| no match | 🔴 unmatched | searchable picker, or "keep as custom" |

### 5.6 Learning loop

When a user resolves a 🟡/🔴 line manually, write a `song_alias` (pending). Approved aliases feed
back into `song_match_key`, so the same free-text string auto-matches next time. The corpus of
existing `.txt` files is the first training set.

**Reuse map**

| Need | Port from |
|---|---|
| Deterministic normalize + null-on-collision map | `the-sorter/src/utils/setlist-prediction/import.ts` |
| Graded candidate scorer | `the-sorter/src/utils/search.ts` **or** `llernote/src/utils/search.ts` (`getSearchScore`) |
| Tiered resolver w/ custom fallback | `llernote/scripts/internal/lib/song-resolver.ts` |
| Normalizers, Levenshtein, similarity | `llernote/scripts/internal/lib/string-match.ts` |
| Paste→match→confirm→persist UX pattern | `llernote/src/components/eventernote/EventernoteImportDialog.tsx` |
| Bipartite "no two lines → same song" assignment | `llernote/src/utils/eventernote.ts` |
| Artist-half disambiguation | `the-sorter/src/hooks/useSongSearch.ts`, `SongCard.tsx#formatArtistsWithVariants` |

---

## 6. Aggregation across inconsistent subsets (the fairness problem)

**Principle: "not ranked" ≠ "ranked last." Absence because a song was out of the list's universe
must not penalize it.** The current pooled/tied-last approach violates this.

### 6.1 Establish eligibility per (list, song)

A song is **eligible** in a list if it was plausibly in that ranker's universe:
- `scope_type='all'` → every catalog song is eligible.
- `scope_type='series'` → songs whose `series_ids` include `scope_ref`.
- `scope_type='performance'` → songs in that setlist.
- `scope_type='custom'` → eligibility = the union of songs the list actually ranked (can't infer
  more). Custom lists only contribute to pairwise/relative measures, not to "penalize absence."

Aggregation only counts a list's opinion about songs it was eligible to rank.

### 6.2 Primary metric — mean normalized rank (eligibility-aware)

For song *s* in list *L* of length *N_L*, normalized position `p = rank / N_L` ∈ (0,1]
(#1 of 40 and #1 of 600 both ≈ top). Aggregate over **eligible** lists only:

```
avg_norm(s, scope) = mean_{L : s eligible in L} normalized_rank(s, L)
```
- Bayesian shrinkage toward the global mean for songs with few appearances:
  `score = (n·avg_norm + k·prior) / (n + k)` (k ≈ 3–5) so a song ranked #1 on one niche list
  doesn't outrank a song consistently top-10 across 30 lists.
- Report `n_lists` and `stddev` as confidence; expose a "min N" filter in the UI.

### 6.3 Consensus metric — Borda / Copeland (robust to partial lists)

Rank aggregation from partial rankings is a standard social-choice problem. Offer a pairwise
consensus alongside the average:
- **Borda:** each list awards `N_L − rank` points, normalized by `N_L`; sum across lists.
- **Copeland (pairwise):** for each pair (a,b) both present in a list, tally who's ranked higher;
  consensus order = win-minus-loss record. Naturally uses only co-occurring songs, so it's immune
  to the different-universe problem.

Present avg-normalized as default, Borda/Copeland as a toggle. Store all in `aggregate_snapshot`.

### 6.4 Scope-scoped views

Because scope is captured explicitly, the UI can aggregate **within a comparable scope** — "all
Hasunosora lists," "this concert's setlist across N attendees" — where apples-to-apples averaging
is valid, in addition to the global cross-scope consensus.

---

## 7. Submit flow (UX)

`/submit` (new page, vanilla JS; mirrors `EventernoteImportDialog`):

1. **Input** — textarea (paste) **or** `.txt` upload. Fields: ranker name, optional title,
   **scope selector** (All songs / Series ▾ / Performance ▾ / Custom).
2. **Parse** — POST `/api/import/parse` `{text, scope}` → returns per-line matches + candidates.
   No DB write.
3. **Confirm & fix** — a review table: position · raw line · matched song (🟢/🟡/🔴) · candidate
   dropdown / search picker. Show match counts ("54 matched, 3 need review, 1 unmatched"). User
   corrects 🟡/🔴 rows; can drop or keep-as-custom.
4. **Submit** — POST `/api/rankings` with confirmed items → creates a **pending** ranking →
   thank-you screen ("your ranking is queued for review"). Manual corrections spawn pending
   `song_alias` rows.

Abuse controls on submit: Cloudflare Turnstile, per-IP rate limit, min list length (e.g. ≥5
resolved items), near-duplicate detection via `submitter_fp` + item-set hash.

---

## 8. Moderation

`/admin` (protected by Cloudflare Access or a shared secret header):
- Queue of `status='pending'` rankings with parsed preview and match-quality summary.
- Actions: **approve** (→ live in aggregate, triggers snapshot rebuild), **reject**, **edit**
  (fix a mis-match before approving), **approve/reject pending aliases**.
- Every action logged to `moderation_event`.
- Only `approved` rankings enter `aggregate_snapshot`.

---

## 9. API surface (Worker)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/import/parse` | Parse+match text; return candidates. No write. |
| POST | `/api/rankings` | Create a pending ranking from confirmed items. |
| GET | `/api/rankings?status=approved[&scope=]` | List rankings (public = approved only). |
| GET | `/api/rankings/:id` | One ranking with items. |
| GET | `/api/aggregate?scope=all&metric=avg_norm` | Aggregate view (served from snapshot). |
| GET | `/api/catalog` | Songs/artists/series for the front end (or keep static JSON). |
| GET | `/api/admin/pending` | Moderation queue (auth). |
| POST | `/api/admin/rankings/:id/{approve,reject}` | Moderate (auth). |
| POST | `/api/admin/aliases/:id/{approve,reject}` | Moderate learned aliases (auth). |

---

## 10. Catalog sync (the two id-namespace problem)

`song-info.json` (ids like `"502"`) and `hasu-songs.json` (ids like `103101`) are **separate id
spaces**. Sync job (Cloudflare cron or a manual `bun` script):
1. Pull `song-info.json`, `artists-info.json`, `series-info.json` from **the-sorter** (catalog
   source of truth).
2. Upsert `song`/`artist`/`series`; rebuild `song_match_key` (+ approved aliases).
3. Map `hasu-songs.json` entries to canonical `song.id` via the resolver; keep a cross-map for
   Hasu-specific setlist scopes. Unmapped Hasu entries stay resolvable as custom.

---

## 11. Migration plan (phased)

- **Phase 0 — Catalog in DB.** Load catalog + build match keys. No behavior change.
- **Phase 1 — Backfill existing `.txt`.** Run all current `data/rankings/*.txt` through the
  pipeline; store as `source='legacy'`, `status='approved'`. Manually resolve leftovers (seeds the
  alias table). Verify aggregate parity against today's page.
- **Phase 2 — Read from DB.** Point `index.html` at `/api/rankings` + `/api/aggregate` instead of
  the GitHub Contents API. Keep `.txt` PRs working (dual-read) as a fallback.
- **Phase 3 — Submit page.** Ship `/submit` + `/api/import/parse` + `/api/rankings` (pending).
- **Phase 4 — Moderation.** Ship `/admin`; approvals go live.
- **Phase 5 — Retire `.txt` PRs.** Update the header CTA from "add your `.txt` via PR" to "Submit a
  ranking." Keep `.txt` import available inside `/submit`.

---

## 12. Open questions

1. **Hosting move:** OK to migrate from GitHub Pages → Cloudflare Pages? (Or keep Pages + Turso
   over HTTP?)
2. **Admin auth:** Cloudflare Access (email allowlist) vs a shared secret — preference?
3. **Default aggregate metric:** avg-normalized (with shrinkage) vs Borda/Copeland as the headline?
4. **Custom-scope lists:** include them in the global average at all, or restrict to pairwise
   consensus only?
5. **Alias moderation:** auto-approve aliases above a confidence threshold, or always manual?
6. **Catalog sync cadence:** on-demand button vs nightly cron?

---

## 13. Appendix — current-state reference

- Front end: single `index.html` (~600 lines vanilla JS), tabs: Aggregate / Ranking / Per-Song /
  Compare / Sort. Caches catalog in `localStorage`; fetches `.txt` via GitHub Contents API.
- Data: `data/*.json` (894 songs, 8 series) copied from the-sorter; `data/rankings/*.txt`
  (`fullrankings.txt` ~2.6k lines, `hasu6thbelluna.txt` ~440 lines).
- Matching today: `parseLine()` — number strip → drop artist → exact name → substring `includes`.
- Catalog facts: every song has `phoneticName` (894/894) and `englishName` (889/894); **no**
  `aliases` field; 0 duplicate titles in the current set (but uniqueness is only guaranteed
  *within a series*).

---

## 14. `ll-predictions` evaluation (why we don't source from it)

Question raised: *can we reuse ll-predictions' database / read ranking data from it instead of the
static `.txt` files?* Investigated the repo (`~/github/ll-predictions`). Conclusion: **no** — it
doesn't contain the data we need, and (per the lightweight decision) we won't reuse its backend.

**What ll-predictions is:** a "Love Live Prediction League" — users predict upcoming-event outcomes
(setlists, participation, numeric, etc.), now pivoting to a play-money prediction market. Stack:
Bun + Hono + Vike SSR + **Postgres (Cloud SQL)**, Discord OAuth (`arctic`), deployed on Cloud Run
behind Firebase Hosting.

**Why its DB can't replace our `.txt` files:**

| Data we need | In ll-predictions' Postgres? | Reality |
|---|---|---|
| Song/artist/series **catalog** | ❌ No catalog tables at all | Bundled JSON (`ll-predictions/data/*.json`) — **the same files we already have** in `rankings/data/`, from the shared LLFans model. Catalog was never the `.txt` problem; it's already structured JSON. |
| The **ranking lists** (favorite-song rankings) | ❌ Not present | Closest is `setlist_predictions.items_json` (ordered song-ids), but those are *concert setlist predictions*, not the-sorter favorite rankings. the-sorter itself has **no DB** (localStorage + share-URL + `.txt` export). |

So the `.txt` files are the **only** persisted form of the ranking lists today. Eliminating them
requires our own store + a one-time backfill import (Phase 1) — not a read from ll-predictions.

**What ll-predictions *would* have offered (declined per "keep it lightweight"):** a clean,
domain-agnostic backend scaffold — `db.ts` (Postgres singleton + idempotent DDL-on-boot),
`auth.ts` (Discord OAuth **+ guest mode + `DISCORD_ADMIN_IDS` admin allowlist** = a ready-made
open-submit + moderation gate), Hono `/api` + Vike SSR, Cloud Run + Cloud SQL deploy scripts, and
dnd-kit ordered-list / picker UI. If simplicity ever stops being the priority, forking that
scaffold into a standalone sibling service (à la `ll-music-reactions`) is the high-reuse path;
bolting onto ll-predictions itself is **not** advised (mid-market-pivot, 1,478-line `api.ts`,
shared abuse/money-ledger surface).

**What we *do* borrow from the LL ecosystem regardless:** the catalog JSON (already have it), the
matcher logic (`resolveSongId` + `getSearchScore`, §5), and UX patterns (paste→match→confirm from
`EventernoteImportDialog`; ordered-list/picker ideas). Code we port; the backend we don't.
