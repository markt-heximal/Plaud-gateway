/**
 * Device keys made through the API. Admin keys stay in PLAUD_REST_KEYS
 * (rest.env) and only they can make or revoke these. keys.json in the state
 * dir (mode 600) holds a SHA-256 hash of each key, never the key itself, so
 * the file is useless to whoever reads it. A new key is shown once, when it is
 * made.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { KEY_PREFIX } from "./config.ts";

export interface DeviceKey {
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface StoredKey extends DeviceKey {
  sha256: string;
}

export class KeyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** lastUsedAt is written at most this often per key, not on every request. */
const LAST_USED_EVERY_MS = 10 * 60_000;

const digest = (key: string) => createHash("sha256").update(key).digest();

export class KeyStore {
  private readonly path: string | null;
  private readonly reserved: Set<string>;
  private keys: StoredKey[];

  /** `stateDir` null keeps keys in memory only (tests). `reserved` are the admin keys' names. */
  constructor(stateDir: string | null, reserved: Iterable<string> = []) {
    this.path = stateDir === null ? null : join(stateDir, "keys.json");
    this.reserved = new Set(reserved);
    this.keys = this.path && existsSync(this.path)
      ? ((JSON.parse(readFileSync(this.path, "utf8")) as { keys?: StoredKey[] }).keys ?? [])
      : [];
  }

  list(): DeviceKey[] {
    return this.keys.map(({ name, createdAt, lastUsedAt }) => ({ name, createdAt, lastUsedAt }));
  }

  /** Makes a key and returns it. This is the only time the key exists outside the caller. */
  create(name: string): { name: string; key: string; createdAt: string } {
    if (!NAME.test(name)) {
      throw new KeyError(400, "A key name is 1 to 32 lowercase letters, digits or dashes, like \"ipad\".");
    }
    if (this.reserved.has(name) || this.keys.some((k) => k.name === name)) {
      throw new KeyError(409, `There is already a key called "${name}".`);
    }
    const key = `${KEY_PREFIX}${randomBytes(24).toString("hex")}`;
    const createdAt = new Date().toISOString();
    this.keys.push({ name, sha256: digest(key).toString("hex"), createdAt, lastUsedAt: null });
    this.save();
    return { name, key, createdAt };
  }

  revoke(name: string): void {
    if (this.reserved.has(name)) {
      throw new KeyError(409, `"${name}" is an admin key. Remove it from rest.env on the gateway.`);
    }
    const before = this.keys.length;
    this.keys = this.keys.filter((k) => k.name !== name);
    if (this.keys.length === before) throw new KeyError(404, `No key called "${name}".`);
    this.save();
  }

  /** The name of the device key `provided` matches, or null. Records when it was last used. */
  match(provided: string): string | null {
    const got = digest(provided);
    for (const k of this.keys) {
      if (!timingSafeEqual(got, Buffer.from(k.sha256, "hex"))) continue;
      const now = Date.now();
      if (!k.lastUsedAt || now - Date.parse(k.lastUsedAt) > LAST_USED_EVERY_MS) {
        k.lastUsedAt = new Date(now).toISOString();
        this.save();
      }
      return k.name;
    }
    return null;
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ keys: this.keys }, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
