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
| `run` | `rest` and `sync` in one process. **The stack runs this**, so a single process owns `plaud.db`: SQLite's locking across two containers on OrbStack's shared folders is not something to rely on. |
| `status` | Prints what the store holds, to compare with the Plaud app. |
| `health` | Exit 0 when sync has checked Plaud within three intervals, or sync is switched off; for Docker's healthcheck. |

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
- **Line fixes.** Word fixes and lines moved to another speaker are kept on
  the gateway, beside Plaud's text, never over it, and never sent to Plaud.
  A fix applies only while Plaud's line still matches the one it replaced. If
  Plaud changes that line, the fix stays but stops applying, and `/changes`
  logs `line_fix_stale`. Search sees the fixed text.

## API (`rest`)

All JSON. Paths also work under `/plaud/…` for the front door.

| Route | |
|---|---|
| `GET /health` | No key. Counts, whether this copy syncs, the last sync times and heartbeat, and `lastError` (error text only). |
| `GET /recordings?q=&from=YYYY-MM-DD&to=&limit=&offset=` | Newest first. `q` is a full-text search. |
| `GET /recordings/{id}` | Metadata, available blocks, speakers. |
| `GET /recordings/{id}/transcript?block=&fixes=` | Cleaned-up by default; `block` is `transaction_polish`, `transaction`, `outline` or `mark_memo`. Each segment has the display `name`. Line fixes are applied, and a fixed line carries `original` (Plaud's text and speaker); `fixes=off` serves Plaud's text only. `staleFixes` counts fixes on lines Plaud has since changed. |
| `GET /recordings/{id}/notes` | Plaud's note tabs (summary, templates, Ask Plaud). |
| `GET /recordings/{id}/speakers` | Label, name, and source: `plaud`, `fix` or none. |
| `PUT /recordings/{id}/speakers/{label}` | `{"name": "…"}`. A local fix for a speaker Plaud still calls "Speaker N". It never overrides a name set in Plaud, and it isn't sent to Plaud (stage 3). |
| `GET /recordings/{id}/lines` | The line fixes, each with `block`, `startMs`, `text`, `speaker`, `original` and `applies`. |
| `PUT /recordings/{id}/lines/{startMs}?block=` | `{"text": "…", "speaker": "…"}`, either or both. Fixes the one line that starts at `startMs` in `block` (default: the served one). `speaker` must be a label already in that transcript. `null`, or Plaud's own value, clears a field. |
| `DELETE /recordings/{id}/lines/{startMs}?block=` | Removes a line fix. |
| `GET /changes?since=` | New recordings, transcript and notes edits, title changes, speaker and line fixes, and `line_fix_stale` when Plaud edits a fixed line, in order. |
| `GET /keys` | Admin key only. Admin key names, and each device key's name, created and last-used time. Never a key. |
| `POST /keys` | Admin key only. `{"name": "ipad"}`. Makes a device key and returns it once. |
| `DELETE /keys/{name}` | Admin key only. Revokes a device key at once. |

**Keys.** Keys in `PLAUD_REST_KEYS` are *admin* keys. An admin makes and
revokes *device* keys through `/keys`, for example from the dashboard. Device
keys read everything but can't manage keys. They are kept in
`keys.json` (mode 600) in the state dir as SHA-256 hashes, so the file holds no
usable key. A new key works at once, with no restart. To end an admin key,
remove it from `rest.env` and restart.

## Who can reach it

**Tailnet only, never public (ADR 7, Decision 5, option A).** The front door
serves it on the tailnet with no Funnel route. My apps reach it **from the
browser** on a device signed in to Tailscale. coach4me's page, on
`*.lovable.app`, calls the gateway directly, and never through Lovable's cloud.
- **CORS** allows `*.lovable.app` and localhost.
- **Private Network Access.** Preflights from those origins get
  `Access-Control-Allow-Private-Network: true`, which Chrome requires before a
  public page can call a tailnet address.
- **The key is entered per device**, in the app's settings, and stays in that
  browser. It is never built into a published app.
- **Off the tailnet**, the app falls back to its direct Plaud connection.

## Settings

| Variable | Default | |
|---|---|---|
| `PLAUD_STATE_DIR` | `./state` (image: `/state`) | `oauth.json`, `plaud.db`, `keys.json`. Mount `~/stack/state/plaud`. |
| `PLAUD_REST_HOST` | `127.0.0.1` | One address; wildcards are refused. |
| `PLAUD_REST_PORT` | `3411` | |
| `PLAUD_REST_KEYS` | none | The admin keys: `name:key,name:key`. Keys start with `pgk_` (so the inventory collector can strip them) followed by at least 32 characters: `pgk_$(openssl rand -hex 24)`. |
| `PLAUD_SYNC_ENABLED` | `true` | `false` on a standby: the container idles instead of polling Plaud (ADR 4, Decision 6). |
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
PLAUD_REST_KEYS="me:pgk_$(openssl rand -hex 24)" npm start -- rest
curl -s 127.0.0.1:3411/health
```

Stage 2 adds the compose services, the source pin, the collector redaction and
the tailnet route in `ai-factory-mini`.

## Write-back (stage 3)

Not built yet. First, the one-recording test in
[`docs/writeback-test.md`](docs/writeback-test.md) checks whether a speaker
rename through the open-source `plaud-api` reaches the cleaned-up transcript
the Plaud app shows, and changes nothing else.

## Development

```bash
npm install     # dev dependencies only: typescript, @types/node
npm test        # node --test; a fake Plaud with the live connector's response shapes
npm run typecheck
```

Tests never call Plaud and contain no real recordings.
