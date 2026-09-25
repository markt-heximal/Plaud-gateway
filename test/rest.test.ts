import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { loadConfig } from "../src/config.ts";
import { createRestServer, originAllowed } from "../src/rest.ts";
import { Store } from "../src/store.ts";
import { Syncer } from "../src/sync.ts";
import { FakePlaud, sampleLibrary } from "./fake-plaud.ts";

const KEY = `pgk_${"k".repeat(40)}`;
let base = "";
let close: () => void = () => {};

before(async () => {
  const store = new Store(":memory:");
  await new Syncer(new FakePlaud(sampleLibrary()), store, { callDelayMs: 0 }).fullWalk();
  const config = loadConfig({ PLAUD_REST_KEYS: `tests:${KEY}`, PLAUD_STATE_DIR: "/nonexistent" });
  const server = createRestServer(store, config);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const get = (path: string, key: string | null = KEY, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers: { ...(key ? { "X-API-Key": key } : {}), ...headers } });

test("health needs no key and reports the store", async () => {
  const r = await get("/health", null);
  assert.equal(r.status, 200);
  const j = (await r.json()) as { ok: boolean; recordings: number; syncEnabled: boolean; lastError: unknown };
  assert.deepEqual([j.ok, j.recordings, j.syncEnabled, j.lastError], [true, 3, true, null]);
});

test("everything else needs the right key", async () => {
  assert.equal((await get("/recordings", null)).status, 401);
  assert.equal((await get("/recordings", `pgk_${"x".repeat(40)}`)).status, 401);
  assert.equal((await get("/recordings")).status, 200);
});

test("recordings list, search and date filters", async () => {
  const all = (await (await get("/recordings")).json()) as { total: number; recordings: Array<{ id: string }> };
  assert.equal(all.total, 3);
  assert.deepEqual(all.recordings.map((r) => r.id), ["of_a1", "of_b2", "of_c3"]);
  const q = (await (await get("/recordings?q=pricing")).json()) as { recordings: Array<{ id: string }> };
  assert.deepEqual(q.recordings.map((r) => r.id), ["of_a1"]);
  assert.equal((await get("/recordings?from=June")).status, 400);
});

test("transcripts default to the cleaned-up block, with names", async () => {
  const t = (await (await get("/recordings/of_a1/transcript")).json()) as {
    block: string;
    segments: Array<{ speaker: string; name: string }>;
  };
  assert.equal(t.block, "transaction_polish");
  assert.deepEqual(t.segments.map((s) => s.name), ["Mark", "Tarkan", "Speaker 3"]);
  const raw = (await (await get("/recordings/of_a1/transcript?block=transaction")).json()) as {
    segments: Array<{ speaker: string }>;
  };
  assert.equal(raw.segments[1]!.speaker, "Hamid");
  assert.equal((await get("/recordings/of_a1/transcript?block=audio")).status, 400);
  assert.equal((await get("/recordings/of_zz/transcript")).status, 404);
});

test("local speaker fixes apply only to unnamed speakers", async () => {
  const put = (label: string, name: string) =>
    fetch(`${base}/recordings/of_a1/speakers/${encodeURIComponent(label)}`, {
      method: "PUT",
      headers: { "X-API-Key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  assert.equal((await put("Tarkan", "Someone else")).status, 409);
  const ok = await put("Speaker 3", "Tarquin");
  assert.equal(ok.status, 200);
  const t = (await (await get("/recordings/of_a1/transcript")).json()) as { segments: Array<{ name: string }> };
  assert.equal(t.segments[2]!.name, "Tarquin");
  const ch = (await (await get("/changes?since=0")).json()) as { changes: Array<{ kind: string }> };
  assert.equal(ch.changes.at(-1)!.kind, "speaker_fix");
});

test("CORS answers only the allowed origins", async () => {
  const yes = await get("/recordings", KEY, { Origin: "https://coach4me.lovable.app" });
  assert.equal(yes.headers.get("access-control-allow-origin"), "https://coach4me.lovable.app");
  const no = await get("/recordings", KEY, { Origin: "https://evil.example" });
  assert.equal(no.headers.get("access-control-allow-origin"), null);
  assert.ok(!originAllowed("https://a.b.lovable.app", ["https://*.lovable.app"]));
});

test("preflights from allowed pages may reach the private network, others may not", async () => {
  const preflight = (origin: string) =>
    fetch(`${base}/recordings`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true",
      },
    });
  const ok = await preflight("https://coach4me.lovable.app");
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-private-network"), "true");
  const no = await preflight("https://evil.example");
  assert.equal(no.headers.get("access-control-allow-private-network"), null);
  assert.equal(no.headers.get("access-control-allow-origin"), null);
});

test("the /plaud prefix used by the front door works", async () => {
  assert.equal((await get("/plaud/recordings/of_a1")).status, 200);
});

test("config refuses a wildcard bind and keys without the pgk_ prefix", () => {
  assert.throws(() => loadConfig({ PLAUD_REST_HOST: "0.0.0.0" }), /specific address/);
  assert.throws(() => loadConfig({ PLAUD_REST_KEYS: `me:${"a".repeat(48)}` }), /must start with pgk_/);
  assert.throws(() => loadConfig({ PLAUD_REST_KEYS: "me:pgk_short" }), /too short/);
});

test("sync is on unless switched off", () => {
  assert.equal(loadConfig({}).syncEnabled, true);
  assert.equal(loadConfig({ PLAUD_SYNC_ENABLED: "false" }).syncEnabled, false);
  assert.equal(loadConfig({ PLAUD_SYNC_ENABLED: "0" }).syncEnabled, false);
  assert.equal(loadConfig({ PLAUD_SYNC_ENABLED: "true" }).syncEnabled, true);
});
