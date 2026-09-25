/**
 * plaud-gateway <mode>
 *   auth     one-time sign-in to Plaud; saves tokens to $PLAUD_STATE_DIR/oauth.json
 *   sync     keeps the local store current (add --once for a single pass)
 *   rest     serves the store to my apps
 *   status   prints what the store holds, to compare with the Plaud app
 *   health   exit 0 when sync is current (or switched off), 1 otherwise; for Docker
 */
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { PlaudMcp } from "./mcp.ts";
import { interactiveAuth, TokenSource } from "./oauth.ts";
import { createRestServer } from "./rest.ts";
import { Store } from "./store.ts";
import { Syncer } from "./sync.ts";

// Recordings are sensitive: every file this process creates is private to its owner.
process.umask(0o077);

const DAY = 86_400_000;
const olderThan = (iso: string | null, ms: number) => !iso || Date.now() - Date.parse(iso) > ms;

async function syncLoop(once: boolean) {
  const config = loadConfig();
  if (!config.syncEnabled && !once) {
    // A standby keeps the container up but never polls Plaud (ADR 4, Decision 6).
    log.info("sync is switched off on this host (PLAUD_SYNC_ENABLED); idling");
    await new Promise<void>((resolve) => {
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => resolve());
    });
    return;
  }
  const store = Store.open(config.stateDir);
  const tokens = new TokenSource(config.stateDir);
  const syncer = new Syncer(new PlaudMcp((force) => tokens.get(force)), store, {
    callDelayMs: config.callDelayMs,
  });

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));

  do {
    try {
      // A weekly full walk also picks up title changes on older recordings.
      if (olderThan(store.getMeta("full_walk_at"), 7 * DAY)) await syncer.fullWalk();
      else await syncer.incremental();
      if (olderThan(store.getMeta("sweep_at"), DAY)) await syncer.sweep(config.sweepDays);
      store.setMeta("last_error", "");
    } catch (e) {
      const err = e as Error;
      store.setMeta("last_error", `${new Date().toISOString()} ${err.name}: ${err.message}`);
      log.error("sync pass failed", { error: err.message, auth: err.name === "PlaudAuthError" });
      if (once) process.exitCode = 1;
    }
    if (once) break;
    const until = Date.now() + config.incrementalMinutes * 60_000;
    while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
  } while (!stopping);
  store.close();
}

function serve() {
  const config = loadConfig();
  const store = Store.open(config.stateDir);
  const server = createRestServer(store, config);
  server.listen(config.restPort, config.restHost, () =>
    log.info("rest listening", { host: config.restHost, port: config.restPort, callers: [...config.restKeys.values()] }),
  );
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => server.close(() => store.close()));
  }
}

function status() {
  const config = loadConfig();
  const store = Store.open(config.stateDir);
  console.log(
    JSON.stringify(
      {
        ...store.counts(),
        fullWalkAt: store.getMeta("full_walk_at"),
        fullWalkSeen: store.getMeta("full_walk_seen"),
        incrementalAt: store.getMeta("incremental_at"),
        sweepAt: store.getMeta("sweep_at"),
        lastError: store.getMeta("last_error") || null,
      },
      null,
      2,
    ),
  );
  store.close();
}

/** For Docker's healthcheck: a running sync has checked Plaud within three intervals. */
function health() {
  const config = loadConfig();
  if (!config.syncEnabled) process.exit(0);
  const store = Store.open(config.stateDir);
  const last = store.getMeta("heartbeat");
  const error = store.getMeta("last_error");
  store.close();
  const fresh = last !== null && Date.now() - Date.parse(last) < 3 * config.incrementalMinutes * 60_000;
  if (!fresh || error) {
    console.error(error || `no successful sync since ${last ?? "start"}`);
    process.exit(1);
  }
}

const [mode, ...rest] = process.argv.slice(2);
switch (mode) {
  case "auth":
    await interactiveAuth(loadConfig());
    break;
  case "sync":
    await syncLoop(rest.includes("--once"));
    break;
  case "rest":
    serve();
    break;
  case "status":
    status();
    break;
  case "health":
    health();
    break;
  default:
    console.error("usage: plaud-gateway auth | sync [--once] | rest | status | health");
    process.exit(2);
}
