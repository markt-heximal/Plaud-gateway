import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { loadConfig } from "../src/config.ts";
import { KeyStore } from "../src/keys.ts";
import { createRestServer } from "../src/rest.ts";
import { Store } from "../src/store.ts";
import { Syncer } from "../src/sync.ts";
import { FakePlaud, sampleLibrary } from "./fake-plaud.ts";

const ADMIN = `pgk_${"a".repeat(40)}`;
const dir = mkdtempSync(join(tmpdir(), "pg-keys-"));
let base = "";
let close: () => void = () => {};

before(async () => {
  const store = new Store(":memory:");
  await new Syncer(new FakePlaud(sampleLibrary()), store, { callDelayMs: 0 }).fullWalk();
  const config = loadConfig({ PLAUD_REST_KEYS: `me:${ADMIN}`, PLAUD_STATE_DIR: dir });
  const server = createRestServer(store, config, new KeyStore(dir, config.restKeys.values()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const call = (method: string, path: string, key: string | null, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { ...(key ? { "X-API-Key": key } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

test("an admin makes a device key; it works at once and is shown only once", async () => {
  const r = await call("POST", "/keys", ADMIN, { name: "ipad" });
  assert.equal(r.status, 200);
  const made = (await r.json()) as { name: string; key: string };
  assert.equal(made.name, "ipad");
  assert.match(made.key, /^pgk_[0-9a-f]{48}$/);

  assert.equal((await call("GET", "/recordings", made.key)).status, 200);

  const file = readFileSync(join(dir, "keys.json"), "utf8");
  assert.ok(!file.includes(made.key), "keys.json holds a hash, never the key");
  assert.equal(statSync(join(dir, "keys.json")).mode & 0o777, 0o600);

  const list = (await (await call("GET", "/keys", ADMIN)).json()) as {
    admins: string[];
    keys: Array<{ name: string; lastUsedAt: string | null }>;
  };
  assert.deepEqual(list.admins, ["me"]);
  assert.deepEqual(list.keys.map((k) => k.name), ["ipad"]);
  assert.ok(list.keys[0]!.lastUsedAt, "a used key records when");
  assert.ok(!JSON.stringify(list).includes("pgk_"), "the list never carries a key");
});

test("a device key reads but cannot manage keys", async () => {
  const { key } = (await (await call("POST", "/keys", ADMIN, { name: "phone" })).json()) as { key: string };
  assert.equal((await call("GET", "/keys", key)).status, 403);
  assert.equal((await call("POST", "/keys", key, { name: "sneaky" })).status, 403);
  assert.equal((await call("DELETE", "/keys/phone", key)).status, 403);
  assert.equal((await call("GET", "/keys", null)).status, 401);
});

test("revoking a key stops it at once; admin keys can't be revoked here", async () => {
  const { key } = (await (await call("POST", "/keys", ADMIN, { name: "laptop" })).json()) as { key: string };
  assert.equal((await call("GET", "/recordings", key)).status, 200);
  assert.equal((await call("DELETE", "/keys/laptop", ADMIN)).status, 200);
  assert.equal((await call("GET", "/recordings", key)).status, 401);
  assert.equal((await call("DELETE", "/keys/laptop", ADMIN)).status, 404);
  assert.equal((await call("DELETE", "/keys/me", ADMIN)).status, 409);
});

test("names are checked: format, and no clash with another key or an admin", async () => {
  assert.equal((await call("POST", "/keys", ADMIN, { name: "My iPad!" })).status, 400);
  assert.equal((await call("POST", "/keys", ADMIN, { name: "" })).status, 400);
  assert.equal((await call("POST", "/keys", ADMIN, { name: "me" })).status, 409);
  assert.equal((await call("POST", "/keys", ADMIN, { name: "tablet" })).status, 200);
  assert.equal((await call("POST", "/keys", ADMIN, { name: "tablet" })).status, 409);
});

test("device keys survive a restart: the store reloads keys.json", async () => {
  const { key } = (await (await call("POST", "/keys", ADMIN, { name: "kept" })).json()) as { key: string };
  const again = new KeyStore(dir, ["me"]);
  assert.equal(again.match(key), "kept");
});

test("CORS lets the dashboard make and revoke keys", async () => {
  const r = await fetch(base + "/keys", {
    method: "OPTIONS",
    headers: { Origin: "https://plaud-gateway.lovable.app", "Access-Control-Request-Method": "DELETE" },
  });
  assert.match(r.headers.get("access-control-allow-methods") ?? "", /POST, DELETE/);
});
