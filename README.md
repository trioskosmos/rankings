# rankings

Aggregates Love Live! song rankings made in [the-sorter](https://github.com/hamproductions/the-sorter).
Direct web submit + fuzzy song matching + fair cross-list aggregation, backed by SQLite (Cloudflare D1).

See [`docs/import-redesign-spec.md`](docs/import-redesign-spec.md) for the full design.

## What's here

| Piece | Path |
|---|---|
| Front end (vanilla) | `index.html` (browse/aggregate), `submit.html` (submit flow) |
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
bun run local:setup     # generate seed SQL + build local.db (schema + catalog + events + backfilled txt)
bun run dev             # http://localhost:8788
```

Pages:
- `/` — browse & aggregate (reads `/api/rankings`, `/api/aggregate`)
- `/submit.html` — paste/upload → review matches → submit (goes live immediately)

Handy checks:
```bash
bun run test:matcher    # match-rate report against data/rankings/*.txt (currently 99.8%)
bun run typecheck       # tsc for deploy code + scripts
```

> `bun run dev` runs a local Bun server using the same handlers as the Functions, backed by
> `bun:sqlite`. `bun run dev:wrangler` uses `wrangler pages dev` against real D1 (needs a
> Wrangler/Node combo without the Node 26 `d1 execute` EPIPE issue).

## Deployment (for the maintainer)

> **Heads up — this adds infrastructure the original static site did not have.**
> The submit flow, matching, and aggregation run in server code (`functions/api/**`)
> against a SQLite database (**Cloudflare D1**). GitHub Pages is static-only and
> **cannot run this**, so the app moves to **Cloudflare Pages + Functions + D1**.
>
> **What you need:** a **Cloudflare account** (new signup — but the free tier
> comfortably covers a hobby site: Pages static hosting, ~100k function
> requests/day, D1 5 GB + 5M reads/day). Plus the `wrangler` CLI, authed once.
> **Local development needs none of this** — `bun run local:setup && bun run dev`.

### One-time setup

```bash
npm i -g wrangler && wrangler login          # Cloudflare account + CLI auth
wrangler d1 create rankings                  # copy the returned database_id into wrangler.toml
wrangler d1 execute rankings --remote --file=schema/schema.sql
bun run catalog:build  && wrangler d1 execute rankings --remote --file=schema/seed-catalog.sql
bun run events:build   && wrangler d1 execute rankings --remote --file=schema/seed-events.sql
bun run rankings:build && wrangler d1 execute rankings --remote --file=schema/seed-rankings.sql
wrangler pages deploy .                      # first run: pick a project name; gives a *.pages.dev URL
```

Confirm the `[[d1_databases]]` binding (`DB` → `rankings`) is picked up by the
Pages project (Settings → Functions → D1 bindings). For ongoing deploys, either
re-run `wrangler pages deploy .`, or connect the repo in the Cloudflare dashboard
for auto-deploy on push (build command: none; output dir: `.`).

### Gotchas
- **The site moves off GitHub Pages.** GitHub Pages can't serve the `/api`
  backend, so the app is hosted on Cloudflare Pages. To keep an existing URL,
  repoint DNS to Cloudflare Pages (or use the `*.pages.dev` / a custom domain).
- **Schema changes need a manual migration on an existing DB.** The schema uses
  `CREATE TABLE IF NOT EXISTS`, which does **not** alter tables that already
  exist. On a fresh D1 it's clean, but if you later pull a schema change (a new
  column, etc.) onto an already-provisioned DB, run the corresponding
  `ALTER TABLE … ADD COLUMN …` (or drop + recreate the affected catalog/event
  tables and reload their seeds) before re-seeding.
- **New concerts don't appear automatically.** The catalog/event data is a
  committed static snapshot; refreshing it (a scheduled sync from
  `ll-sorter-scripts`) is planned as a separate follow-up.

## Data model

`song` / `artist` / `series` (catalog) · `song_match_key` (normalized keys, null-on-collision) ·
`song_alias` (learned from confirmed imports) · `event` / `event_song` (concert legs + setlist unions) ·
`ranking` / `ranking_item` (raw line kept for audit) · `submit_rate`. Full DDL in `schema/schema.sql`.
