import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { loadConfig } from "../src/config.ts";
import { createRestServer } from "../src/rest.ts";
import { Store } from "../src/store.ts";
import { Syncer } from "../src/sync.ts";
import { FakePlaud, sampleLibrary } from "./fake-plaud.ts";

const KEY = `pgk_${"f".repeat(40)}`;
const plaud = new FakePlaud(sampleLibrary());
const store = new Store(":memory:");
const syncer = new Syncer(plaud, store, { callDelayMs: 0 });
let base = "";
let close: () => void = () => {};

before(async () => {
  await syncer.fullWalk();
  const server = createRestServer(store, loadConfig({ PLAUD_REST_KEYS: `tests:${KEY}`, PLAUD_STATE_DIR: "/nonexistent" }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const call = (method: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { "X-API-Key": KEY, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
type Seg = { text: string; speaker: string; name: string; original?: { text: string; speaker: string } };
const transcript = async (q = "") =>
  (await (await call("GET", `/recordings/of_a1/transcript${q}`)).json()) as { segments: Seg[]; staleFixes: number };

test("a word fix changes one line, keeps Plaud's text beside it, and is searchable", async () => {
  const r = await call("PUT", "/recordings/of_a1/lines/30000", { text: "Agreed, pricing goes first." });
  assert.equal(r.status, 200);
  const t = await transcript();
  assert.equal(t.segments[2]!.text, "Agreed, pricing goes first.");
  assert.deepEqual(t.segments[2]!.original, { text: "Agreed, pricing first.", speaker: "Speaker 3" });
  assert.equal(t.segments[1]!.original, undefined);
  assert.equal((await transcript("?fixes=off")).segments[2]!.text, "Agreed, pricing first.");
  const found = (await (await call("GET", "/recordings?q=goes")).json()) as { recordings: Array<{ id: string }> };
  assert.deepEqual(found.recordings.map((x) => x.id), ["of_a1"]);
  const ch = (await (await call("GET", "/changes?since=0")).json()) as { changes: Array<{ kind: string; detail: string }> };
  assert.deepEqual([ch.changes.at(-1)!.kind, ch.changes.at(-1)!.detail], ["line_fix", "transaction_polish@30000"]);
});

test("a line moves to a speaker already in the transcript, and the word fix stays", async () => {
  assert.equal((await call("PUT", "/recordings/of_a1/lines/30000", { speaker: "Nobody" })).status, 400);
  assert.equal((await call("PUT", "/recordings/of_a1/lines/30000", { speaker: "Tarkan" })).status, 200);
  const t = await transcript();
  assert.deepEqual([t.segments[2]!.speaker, t.segments[2]!.name], ["Tarkan", "Tarkan"]);
  assert.equal(t.segments[2]!.text, "Agreed, pricing goes first.");
  const sp = (await (await call("GET", "/recordings/of_a1/speakers")).json()) as {
    speakers: Array<{ label: string; turns: number }>;
  };
  assert.equal(sp.speakers.find((s) => s.label === "Tarkan")!.turns, 2);
});

test("bad targets are refused", async () => {
  assert.equal((await call("PUT", "/recordings/of_a1/lines/12345", { text: "x" })).status, 404);
  assert.equal((await call("PUT", "/recordings/of_a1/lines/7860", {})).status, 400);
  assert.equal((await call("PUT", "/recordings/of_a1/lines/7860", { text: 5 })).status, 400);
  assert.equal((await call("PUT", "/recordings/of_a1/lines/7860?block=audio", { text: "x" })).status, 400);
  assert.equal((await call("PUT", "/recordings/of_zz/lines/7860", { text: "x" })).status, 404);
});

test("setting a field back to Plaud's value clears it; clearing both removes the fix", async () => {
  await call("PUT", "/recordings/of_a1/lines/7860", { text: "Let us start with the roadmap." });
  await call("PUT", "/recordings/of_a1/lines/7860", { text: "Let's start with the roadmap." });
  const fixes = (await (await call("GET", "/recordings/of_a1/lines")).json()) as { fixes: Array<{ startMs: number }> };
  assert.deepEqual(fixes.fixes.map((f) => f.startMs), [30000]);
  assert.equal((await call("DELETE", "/recordings/of_a1/lines/7860")).status, 404);
});

test("when Plaud edits a fixed line, the fix is kept but not applied, and /changes says so", async () => {
  const before = (await (await call("GET", "/changes?since=0")).json()) as { next: number };
  plaud.library[0]!.polish![2]!.content = "Agreed: pricing first, then hiring.";
  await syncer.sweep(3650);
  const t = await transcript();
  assert.equal(t.segments[2]!.text, "Agreed: pricing first, then hiring.");
  assert.equal(t.segments[2]!.speaker, "Speaker 3");
  assert.equal(t.staleFixes, 1);
  const lines = (await (await call("GET", "/recordings/of_a1/lines")).json()) as { fixes: Array<{ applies: boolean }> };
  assert.deepEqual(lines.fixes.map((f) => f.applies), [false]);
  const ch = (await (await call("GET", `/changes?since=${before.next}`)).json()) as {
    changes: Array<{ kind: string; detail: string }>;
  };
  assert.ok(ch.changes.some((c) => c.kind === "line_fix_stale" && c.detail === "transaction_polish: 1"));

  // A new fix on that line replaces the stale one, anchored to Plaud's new text.
  await call("PUT", "/recordings/of_a1/lines/30000", { speaker: "Mark" });
  const after = (await (await call("GET", "/recordings/of_a1/lines")).json()) as {
    fixes: Array<{ applies: boolean; text: string | null; original: { text: string } }>;
  };
  assert.deepEqual(after.fixes, [
    { ...after.fixes[0]!, applies: true, text: null, original: { ...after.fixes[0]!.original, text: "Agreed: pricing first, then hiring." } },
  ]);
  assert.equal((await call("DELETE", "/recordings/of_a1/lines/30000")).status, 200);
  assert.equal((await transcript()).segments[2]!.speaker, "Speaker 3");
});
