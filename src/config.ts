import { join } from "node:path";

/** Everything is set by environment variables; nothing secret lives in the image. */
export interface Config {
  /** Holds oauth.json and plaud.db. Mounted from ~/stack/state/plaud. */
  stateDir: string;
  /** Address and port for `rest`. Loopback or a fixed private address, never a wildcard. */
  restHost: string;
  restPort: number;
  /** API keys for `rest`, as name:key pairs, e.g. "agents:abc,coach4me:def". */
  restKeys: Map<string, string>;
  /** Origins allowed by CORS. "*" inside a pattern matches one DNS label. */
  corsOrigins: string[];
  /** Minutes between checks for new recordings. */
  incrementalMinutes: number;
  /** How far back the nightly edit sweep re-reads transcripts and notes. */
  sweepDays: number;
  /** Pause between Plaud calls, to stay a polite client. */
  callDelayMs: number;
  /** Loopback port for the one-time `auth` sign-in callback. */
  authPort: number;
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", ""]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = env["PLAUD_STATE_DIR"] ?? join(process.cwd(), "state");
  const restHost = env["PLAUD_REST_HOST"] ?? "127.0.0.1";
  if (WILDCARD_HOSTS.has(restHost)) {
    // Same rule as remarkable-mcp: this serves private recordings, so it binds one address.
    throw new Error(`PLAUD_REST_HOST must be a specific address, not "${restHost}".`);
  }
  const restKeys = new Map<string, string>();
  for (const pair of (env["PLAUD_REST_KEYS"] ?? "").split(",")) {
    const [name, key] = pair.split(":").map((s) => s.trim());
    if (!name || !key) continue;
    if (key.length < 24) throw new Error(`PLAUD_REST_KEYS: the key for "${name}" is too short.`);
    restKeys.set(key, name);
  }
  const num = (name: string, fallback: number) => {
    const v = env[name];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number.`);
    return n;
  };
  return {
    stateDir,
    restHost,
    restPort: num("PLAUD_REST_PORT", 3411),
    restKeys,
    corsOrigins: (env["PLAUD_CORS_ORIGINS"] ?? "https://*.lovable.app,http://localhost:8080")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    incrementalMinutes: num("PLAUD_INCREMENTAL_MINUTES", 15),
    sweepDays: num("PLAUD_SWEEP_DAYS", 30),
    callDelayMs: num("PLAUD_CALL_DELAY_MS", 250),
    authPort: num("PLAUD_AUTH_PORT", 3419),
  };
}
