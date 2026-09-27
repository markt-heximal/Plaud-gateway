/**
 * A small read API over the local store (ADR 7, Decision 4). Every route but
 * /health needs X-API-Key; CORS is limited to the configured origins. It
 * binds one address and never serves audio.
 *
 * Two kinds of key: admin keys from PLAUD_REST_KEYS, and device keys that an
 * admin makes and revokes through /keys (keys.ts). Both read everything; only
 * admin keys manage keys.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";

import type { Config } from "./config.ts";
import { KeyError, KeyStore } from "./keys.ts";
import { log } from "./log.ts";
import type { Block } from "./normalise.ts";
import { BLOCKS } from "./normalise.ts";
import type { Store } from "./store.ts";

type Handler = (p: {
  req: IncomingMessage;
  url: URL;
  params: string[];
  caller: string;
  admin: boolean;
}) => Promise<unknown> | unknown;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function originAllowed(origin: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p === origin) return true;
    if (!p.includes("*")) return false;
    const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join("[a-z0-9-]+")}$`, "i");
    return re.test(origin);
  });
}

function keyCaller(
  provided: string | undefined,
  admins: Map<string, string>,
  devices: KeyStore,
): { name: string; admin: boolean } | null {
  if (!provided) return null;
  const a = Buffer.from(provided);
  for (const [key, name] of admins) {
    const b = Buffer.from(key);
    if (a.length === b.length && timingSafeEqual(a, b)) return { name, admin: true };
  }
  const name = devices.match(provided);
  return name ? { name, admin: false } : null;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw new HttpError(413, "Body too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
}

export function buildRoutes(store: Store): Array<[string, RegExp, Handler]> {
  const need = (id: string) => {
    const rec = store.getRecording(id);
    if (!rec) throw new HttpError(404, "No such recording.");
    return rec;
  };
  /** A line is its block (default: the preferred one) and its start time in ms. */
  const lineTarget = (params: string[], url: URL) => {
    const id = params[0]!;
    need(id);
    const asked = url.searchParams.get("block");
    if (asked && !(BLOCKS as readonly string[]).includes(asked)) {
      throw new HttpError(400, `block is one of ${BLOCKS.join(", ")}.`);
    }
    const block = (asked as Block | null) ?? store.preferredTranscript(id)?.block;
    if (!block) throw new HttpError(404, "No transcript for this recording yet.");
    return { id, block, startMs: Number(params[1]) };
  };
  return [
    [
      "GET",
      /^\/recordings$/,
      ({ url }) => {
        const q = url.searchParams.get("q")?.trim() || undefined;
        const from = url.searchParams.get("from") || undefined;
        const to = url.searchParams.get("to") || undefined;
        if ((from && !DATE.test(from)) || (to && !DATE.test(to))) {
          throw new HttpError(400, "from and to are YYYY-MM-DD.");
        }
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
        const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
        const { recordings, total } = store.listRecordings({
          ...(q ? { q } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          limit,
          offset,
        });
        return { recordings, total, limit, offset, complete: true };
      },
    ],
    [
      "GET",
      /^\/recordings\/([\w-]+)$/,
      ({ params }) => {
        const id = params[0]!;
        return { ...need(id), blocks: store.blocksFor(id), speakers: store.speakers(id) };
      },
    ],
    [
      "GET",
      /^\/recordings\/([\w-]+)\/transcript$/,
      ({ params, url }) => {
        const id = params[0]!;
        need(id);
        const asked = url.searchParams.get("block");
        if (asked && !(BLOCKS as readonly string[]).includes(asked)) {
          throw new HttpError(400, `block is one of ${BLOCKS.join(", ")}.`);
        }
        const t = asked
          ? { block: asked as Block, segments: store.getBlock(id, asked as Block) }
          : store.preferredTranscript(id);
        if (!t?.segments) throw new HttpError(404, "No transcript for this recording yet.");
        // fixes=off serves Plaud's text as synced, without line fixes.
        const segments = url.searchParams.get("fixes") === "off" ? t.segments : store.withFixes(id, t.block, t.segments);
        const names = new Map(store.speakers(id).map((s) => [s.label, s.name]));
        return {
          id,
          block: t.block,
          segments: segments.map((s) => ({ ...s, name: names.get(s.speaker) ?? s.speaker })),
          staleFixes: store.lineFixes(id).filter((f) => f.block === t.block && !f.applies).length,
        };
      },
    ],
    [
      "GET",
      /^\/recordings\/([\w-]+)\/notes$/,
      ({ params }) => {
        const id = params[0]!;
        need(id);
        return { id, notes: store.getNotes(id) ?? [] };
      },
    ],
    [
      "GET",
      /^\/recordings\/([\w-]+)\/speakers$/,
      ({ params }) => {
        const id = params[0]!;
        need(id);
        return { id, speakers: store.speakers(id) };
      },
    ],
    [
      "PUT",
      /^\/recordings\/([\w-]+)\/speakers\/([^/]+)$/,
      async ({ params, req, caller }) => {
        const id = params[0]!;
        const label = decodeURIComponent(params[1]!);
        need(id);
        const known = store.speakers(id).find((s) => s.label === label);
        if (!known) throw new HttpError(404, "No such speaker in this recording.");
        if (known.source === "plaud") throw new HttpError(409, "This speaker is already named in Plaud.");
        const body = (await readJson(req)) as { name?: unknown };
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
        store.setSpeakerFix(id, label, name || null);
        log.info("speaker fix saved locally", { id, label, caller, cleared: !name });
        return { id, speakers: store.speakers(id) };
      },
    ],
    [
      "GET",
      /^\/recordings\/([\w-]+)\/lines$/,
      ({ params }) => {
        const id = params[0]!;
        need(id);
        return { id, fixes: store.lineFixes(id) };
      },
    ],
    [
      "PUT",
      /^\/recordings\/([\w-]+)\/lines\/(\d+)$/,
      async ({ params, req, url, caller }) => {
        const { id, block, startMs } = lineTarget(params, url);
        const body = (await readJson(req)) as { text?: unknown; speaker?: unknown };
        const field = (v: unknown, max: number, what: string) => {
          if (v === undefined || v === null) return v;
          if (typeof v !== "string") throw new HttpError(400, `${what} is a string or null.`);
          return v.trim().slice(0, max) || null;
        };
        const text = field(body.text, 5000, "text");
        const speaker = field(body.speaker, 80, "speaker");
        if (text === undefined && speaker === undefined) throw new HttpError(400, "Send text, speaker or both.");
        const segments = store.getBlock(id, block) ?? [];
        // A line moves to someone already in this transcript; name new people through /speakers.
        if (speaker && !segments.some((s) => s.speaker === speaker)) {
          throw new HttpError(400, "speaker must be a speaker label already in this transcript.");
        }
        try {
          store.setLineFix(id, block, startMs, {
            ...(text !== undefined ? { text } : {}),
            ...(speaker !== undefined ? { speaker } : {}),
          });
        } catch (e) {
          const msg = (e as Error).message;
          if (msg === "no such line") throw new HttpError(404, "No line starts at that time in this block.");
          if (msg === "ambiguous line") throw new HttpError(409, "More than one line starts at that time.");
          throw e;
        }
        log.info("line fix saved locally", { id, block, startMs, caller });
        return { id, fixes: store.lineFixes(id) };
      },
    ],
    [
      "DELETE",
      /^\/recordings\/([\w-]+)\/lines\/(\d+)$/,
      ({ params, url, caller }) => {
        const { id, block, startMs } = lineTarget(params, url);
        if (!store.deleteLineFix(id, block, startMs)) throw new HttpError(404, "No fix on that line.");
        log.info("line fix removed", { id, block, startMs, caller });
        return { id, fixes: store.lineFixes(id) };
      },
    ],
    [
      "GET",
      /^\/changes$/,
      ({ url }) => {
        const since = Math.max(Number(url.searchParams.get("since") ?? 0) || 0, 0);
        const changes = store.changesSince(since, 500);
        return { changes, next: changes.at(-1)?.seq ?? since };
      },
    ],
  ];
}

/** Key management: admin keys only. A new key is in the POST reply and nowhere else. */
export function keyRoutes(keys: KeyStore, admins: Iterable<string>): Array<[string, RegExp, Handler]> {
  const adminOnly = (admin: boolean) => {
    if (!admin) throw new HttpError(403, "Only an admin key can manage keys.");
  };
  return [
    [
      "GET",
      /^\/keys$/,
      ({ admin }) => {
        adminOnly(admin);
        return { admins: [...admins], keys: keys.list() };
      },
    ],
    [
      "POST",
      /^\/keys$/,
      async ({ req, admin, caller }) => {
        adminOnly(admin);
        const body = (await readJson(req)) as { name?: unknown };
        const made = keys.create(typeof body.name === "string" ? body.name.trim() : "");
        log.info("key created", { name: made.name, by: caller });
        return made;
      },
    ],
    [
      "DELETE",
      /^\/keys\/([^/]+)$/,
      ({ params, admin, caller }) => {
        adminOnly(admin);
        const name = decodeURIComponent(params[0]!);
        keys.revoke(name);
        log.info("key revoked", { name, by: caller });
        return { revoked: name };
      },
    ],
  ];
}

export function createRestServer(
  store: Store,
  config: Config,
  keys = new KeyStore(null, config.restKeys.values()),
): Server {
  const routes = [...buildRoutes(store), ...keyRoutes(keys, config.restKeys.values())];
  if (config.restKeys.size === 0) log.warn("PLAUD_REST_KEYS is empty: no admin key, and no one can manage keys");

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const origin = req.headers.origin;
    if (origin && originAllowed(origin, config.corsOrigins)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "X-API-Key, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
      // coach4me's page (public origin) calls this over the tailnet (private
      // address); Chrome's Private Network Access asks us to opt in explicitly.
      if (req.headers["access-control-request-private-network"] === "true") {
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://gateway");
    // Allow a path prefix (the front door proxies /plaud/*).
    const path = url.pathname.replace(/^\/plaud(?=\/)/, "").replace(/\/+$/, "") || "/";

    if (path === "/health" && req.method === "GET") {
      send(200, {
        ok: true,
        ...store.counts(),
        syncEnabled: config.syncEnabled,
        heartbeat: store.getMeta("heartbeat"),
        fullWalkAt: store.getMeta("full_walk_at"),
        incrementalAt: store.getMeta("incremental_at"),
        sweepAt: store.getMeta("sweep_at"),
        // Error text only (e.g. "PlaudAuthError: … Run `auth` again."), never recording content.
        lastError: store.getMeta("last_error") || null,
      });
      return;
    }

    const who = keyCaller(req.headers["x-api-key"] as string | undefined, config.restKeys, keys);
    if (!who) {
      send(401, { error: "Missing or wrong X-API-Key." });
      return;
    }
    for (const [method, re, handler] of routes) {
      const m = re.exec(path);
      if (!m || method !== req.method) continue;
      try {
        send(200, await handler({ req, url, params: m.slice(1), caller: who.name, admin: who.admin }));
      } catch (e) {
        if (e instanceof HttpError || e instanceof KeyError) send(e.status, { error: e.message });
        else {
          log.error("request failed", { path, error: (e as Error).message });
          send(500, { error: "Internal error." });
        }
      }
      return;
    }
    send(404, { error: "Not found." });
  });
}
