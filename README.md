# plaud-gateway

A private copy of my Plaud library, kept current through Plaud's **official,
read-only** MCP connector and served to my apps and agents over the tailnet.
The design is ADR 7 in
[`ai-factory-mini`](https://github.com/markt-heximal/ai-factory-mini/blob/main/decisions/0007-plaud-gateway.md).
This repo is **stage 1**: `sync` and `rest`. There is no write-back yet.

One image with these modes:

| Mode | What it does |
|---|---|
| `auth` | One-time Plaud sign-in (OAuth 2.1 with PKCE). Saves `oauth.json` (mode 600) in the state dir. |
| `sync` | Keeps `plaud.db` current. It does a full walk weekly, checks for new recordings every 15 minutes, and runs a nightly edit sweep over the last 30 days. `--once` runs a single pass. |
| `rest` | Serves the store on one address, with `X-API-Key` on everything but `/health`. |
| `status` | Prints what the store holds, to compare with the Plaud app. |

No runtime dependencies: Node 22 (≥ 22.18) runs the TypeScript sources
directly and has SQLite with full-text search built in. Audio is never stored.

## What it handles so apps don't have to

- **Paging.** `list_files` returns the 20 newest recordings by default. The
  sync walks every page.
- **Search.** Plaud's filtered search stops at the 500 most recent recordings.
  Here, search covers the whole library: titles, transcripts and notes.
- **Units.** Durations are milliseconds, even for a 3-second clip. Times are UTC
  with no zone suffix. Both are stored as seconds and ISO UTC.
- **Transcripts.** Plaud keeps a raw block and a cleaned-up block, and edits
  made in the Plaud app (renamed speakers, corrections) land only in the
  cleaned-up one. Both are stored, and the cleaned-up one is served by default.
- **Edits.** Nothing tells you a recording was edited, so the nightly sweep
  hashes each transcript and notes, and logs a change when the hash moves.
  Apps follow `/changes`.

## API (`rest`)

All JSON. Paths also work under `/plaud/…` for the front door.

| Route | |
|---|---|
| `GET /health` | No key. Counts and last sync times. |
| `GET /recordings?q=&from=YYYY-MM-DD&to=&limit=&offset=` | Newest first. `q` is a full-text search. |
| `GET /recordings/{id}` | Metadata, available blocks, speakers. |
| `GET /recordings/{id}/transcript?block=` | Cleaned-up by default; `block` is `transaction_polish`, `transaction`, `outline` or `mark_memo`. Each segment has the display `name`. |
| `GET /recordings/{id}/notes` | Plaud's note tabs (summary, templates, Ask Plaud). |
| `GET /recordings/{id}/speakers` | Label, name, and source: `plaud`, `fix` or none. |
| `PUT /recordings/{id}/speakers/{label}` | `{"name": "…"}`. A local fix for a speaker Plaud still calls "Speaker N". It never overrides a name set in Plaud, and it isn't sent to Plaud (stage 3). |
| `GET /changes?since=` | New recordings, transcript and notes edits, title changes, and speaker fixes, in order. |

## Settings

| Variable | Default | |
|---|---|---|
| `PLAUD_STATE_DIR` | `./state` (image: `/state`) | `oauth.json`, `plaud.db`. Mount `~/stack/state/plaud`. |
| `PLAUD_REST_HOST` | `127.0.0.1` | One address; wildcards are refused. |
| `PLAUD_REST_PORT` | `3411` | |
| `PLAUD_REST_KEYS` | none | `name:key,name:key`. Keys are at least 24 characters. |
| `PLAUD_CORS_ORIGINS` | `https://*.lovable.app,http://localhost:8080` | |
| `PLAUD_INCREMENTAL_MINUTES` | `15` | |
| `PLAUD_SWEEP_DAYS` | `30` | |
| `PLAUD_CALL_DELAY_MS` | `250` | Pause between Plaud calls. |
| `PLAUD_AUTH_PORT` | `3419` | Loopback callback for `auth`. |

## Stage 1 on the mini

```bash
git clone https://github.com/markt-heximal/plaud-gateway.git ~/projects/plaud-gateway
cd ~/projects/plaud-gateway
export PLAUD_STATE_DIR=~/stack/state/plaud

npm start -- auth          # open the printed link on the mini and approve
npm start -- sync --once   # the first full walk; a few minutes for ~400 recordings
npm start -- status
```

`auth` from another machine: `ssh -L 3419:127.0.0.1:3419 <mini>` first, then
open the link locally.

### Compare with the Plaud app before going further

- [ ] `recordings` matches the count in the Plaud app. It was 363 on 2026-09-25.
- [ ] `oldest` reaches back to the first recording (2025-11-17). This is the
      paging check in ADR 7, Decision 2.
- [ ] `withRawTranscript` ≈ `recordings`. Clips with no transcript are expected
      gaps.
- [ ] On a recording where speakers were renamed in the Plaud app,
      `/recordings/{id}/speakers` shows the new names with source `plaud`.
- [ ] A 3-second clip shows `durationSec: 3`.
- [ ] Rename a speaker in the Plaud app, then run
      `PLAUD_SWEEP_DAYS=3 npm start -- sync --once`. `/changes` shows a
      `transcript` change for it.
- [ ] `ls -l ~/stack/state/plaud` shows both files as `-rw-------`.

Then serve it on loopback:

```bash
PLAUD_REST_KEYS="me:$(openssl rand -hex 24)" npm start -- rest
curl -s 127.0.0.1:3411/health
```

Stage 2 adds the compose services, the source pin, the collector redaction and
the tailnet route in `ai-factory-mini`.

## Development

```bash
npm install     # dev dependencies only: typescript, @types/node
npm test        # node --test; a fake Plaud with the live connector's response shapes
npm run typecheck
```

Tests never call Plaud and contain no real recordings.
