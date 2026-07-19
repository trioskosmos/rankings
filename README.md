# rankings

Aggregates Love Live! song rankings made in [the-sorter](https://github.com/hamproductions/the-sorter).
Direct web submit + fuzzy song matching + fair cross-list aggregation, backed by SQLite (Cloudflare D1).

See [`docs/import-redesign-spec.md`](docs/import-redesign-spec.md) for the full design.

## What's here

| Piece | Path |
|---|---|
| Front end (vanilla) | `index.html` (browse/aggregate), `submit.html` (submit flow), `admin.html` (moderation) |
| API (Cloudflare Pages Functions) | `functions/api/**` — thin wrappers over shared handlers |
| Shared logic | `src/` — matcher, parser, aggregation, handlers, DB interface |
| DB schema + seeds | `schema/` (`schema.sql` + generated `seed-*.sql`) |
| Build / dev scripts | `scripts/` |
| Canonical catalog | `data/*.json` (songs/artists/series, synced from the-sorter) |

The matcher (`src/matcher.ts`) and aggregation (`src/aggregate.ts`) are ports/adaptations of
the-sorter + llernote logic: normalized multi-key resolve with **null-on-collision**, artist-half
disambiguation, graded fuzzy candidates, and eligibility-aware rank aggregation.

## Local development

```bash
bun install
bun run local:setup     # generate seed SQL + build local.db (schema + catalog + backfilled txt)
bun run dev             # http://localhost:8788  (admin token: dev-admin-token)
```

Pages:
- `/` — browse & aggregate (reads `/api/rankings`, `/api/aggregate`)
- `/submit.html` — paste/upload → review matches → submit (pending)
- `/admin.html` — enter the admin token → approve/reject the queue

Handy checks:
```bash
bun run test:matcher    # match-rate report against data/rankings/*.txt (currently 99.8%)
bun run typecheck       # tsc for deploy code + scripts
```

> `bun run dev` runs a local Bun server using the same handlers as the Functions, backed by
> `bun:sqlite`. `bun run dev:wrangler` uses `wrangler pages dev` against real D1 (needs a
> Wrangler/Node combo without the Node 26 `d1 execute` EPIPE issue).

## Deploy (Cloudflare Pages + D1)

```bash
wrangler d1 create rankings                  # put the returned database_id in wrangler.toml
wrangler d1 execute rankings --remote --file=schema/schema.sql
bun run catalog:build && wrangler d1 execute rankings --remote --file=schema/seed-catalog.sql
bun run rankings:build && wrangler d1 execute rankings --remote --file=schema/seed-rankings.sql
wrangler pages secret put ADMIN_TOKEN        # set the real admin token
wrangler pages deploy .
```

## Data model

`song` / `artist` / `series` (catalog) · `song_match_key` (normalized keys, null-on-collision) ·
`song_alias` (learned from confirmed imports) · `ranking` / `ranking_item` (raw line kept for audit)
· `moderation_event` · `submit_rate`. Full DDL in `schema/schema.sql`.
