/**
 * Helpers for docs/writeback-test.md. Reads only, through Plaud's official
 * connector, with the gateway's own sign-in (PLAUD_STATE_DIR/oauth.json).
 *
 *   node tools/writeback-test.ts latest              the five newest recordings
 *   node tools/writeback-test.ts snapshot <id> <file> both transcript blocks to a file
 *   node tools/writeback-test.ts compare <before> <after>
 */
import { readFileSync, writeFileSync } from "node:fs";

import { loadConfig } from "../src/config.ts";
import { PlaudMcp } from "../src/mcp.ts";
import { listRows, normaliseRecording, normaliseSegments } from "../src/normalise.ts";
import { TokenSource } from "../src/oauth.ts";
import type { Snapshot } from "./transcript-diff.ts";
import { diffBlock, verdict } from "./transcript-diff.ts";

process.umask(0o077);
const BLOCKS = ["transaction", "transaction_polish"] as const;

function plaud() {
  const tokens = new TokenSource(loadConfig().stateDir);
  return new PlaudMcp((force) => tokens.get(force));
}

async function readBlock(mcp: PlaudMcp, id: string, block: string) {
  const rows: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    let raw: unknown;
    try {
      raw = await mcp.call("get_transcript", { file_id: id, block, limit: 500, ...(cursor ? { cursor } : {}) });
    } catch (e) {
      if (page === 0) return null;
      throw e;
    }
    const o = (raw ?? {}) as Record<string, unknown>;
    if (!Array.isArray(o["segments"])) return page === 0 ? null : normaliseSegments(rows);
    rows.push(...(o["segments"] as unknown[]));
    const next = o["next_cursor"];
    if (typeof next !== "string" || !next) break;
    cursor = next;
  }
  return normaliseSegments(rows);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "latest") {
  const rows = listRows(await plaud().call("list_files", { page: 1, page_size: 10 }));
  for (const r of rows.slice(0, 5).map(normaliseRecording)) {
    if (r) console.log(`${r.id}  ${r.startedAt ?? ""}  ${r.durationSec ?? "?"}s  ${r.name}`);
  }
} else if (cmd === "snapshot" && a && b) {
  const mcp = plaud();
  const snap: Snapshot = { id: a, takenAt: new Date().toISOString(), blocks: {} };
  for (const block of BLOCKS) snap.blocks[block] = await readBlock(mcp, a, block);
  writeFileSync(b, JSON.stringify(snap, null, 2));
  for (const block of BLOCKS) {
    const segs = snap.blocks[block];
    const speakers = segs ? [...new Set(segs.map((s) => s.speaker))].join(", ") : "-";
    console.log(`${block}: ${segs ? `${segs.length} segments; speakers: ${speakers}` : "none"}`);
  }
  console.log(`saved ${b}`);
} else if (cmd === "compare" && a && b) {
  const before = JSON.parse(readFileSync(a, "utf8")) as Snapshot;
  const after = JSON.parse(readFileSync(b, "utf8")) as Snapshot;
  if (before.id !== after.id) throw new Error("the two snapshots are of different recordings");
  for (const block of BLOCKS) {
    const d = diffBlock(block, before.blocks[block] ?? null, after.blocks[block] ?? null);
    console.log(`${block}: ${verdict(d)}`);
    console.log(
      `  segments ${d.segments[0]} -> ${d.segments[1]}; text changes ${d.textChanges}; time changes ${d.timeChanges}; speaker changes ${JSON.stringify(d.speakerChanges)}`,
    );
  }
} else {
  console.error("usage: writeback-test.ts latest | snapshot <id> <file> | compare <before> <after>");
  process.exit(2);
}
