/**
 * Pulls the library from Plaud's official connector (ADR 7, Decision 2):
 * - a full walk of every page, which is not subject to the 500-recording
 *   limit that filtered searches have;
 * - an incremental check of the newest page for new recordings;
 * - a sweep that re-reads recent transcripts and notes and records a change
 *   when their content hash moves: the only way to see edits made in the
 *   Plaud app, since nothing in a row says it was edited.
 * Audio is never stored.
 */
import type { PlaudSource } from "./mcp.ts";
import { log } from "./log.ts";
import type { Block } from "./normalise.ts";
import { BLOCKS, contentHash, listRows, normaliseRecording, normaliseSegments } from "./normalise.ts";
import type { NoteTab, Store } from "./store.ts";

export interface SyncOptions {
  callDelayMs: number;
  pageSize?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Syncer {
  private readonly plaud: PlaudSource;
  private readonly store: Store;
  private readonly opts: SyncOptions;
  private readonly pageSize: number;

  constructor(plaud: PlaudSource, store: Store, opts: SyncOptions) {
    this.plaud = plaud;
    this.store = store;
    this.opts = opts;
    this.pageSize = opts.pageSize ?? 100;
  }

  private async call(tool: string, args: Record<string, unknown>) {
    const out = await this.plaud.call(tool, args);
    if (this.opts.callDelayMs) await sleep(this.opts.callDelayMs);
    return out;
  }

  /** Walks every page, newest first, until a short page. */
  async fullWalk(): Promise<{ seen: number; added: number; pages: number }> {
    let seen = 0;
    let added = 0;
    let page = 1;
    for (; page <= 1000; page++) {
      const rows = listRows(await this.call("list_files", { page, page_size: this.pageSize }));
      for (const row of rows) {
        const rec = normaliseRecording(row);
        if (!rec) continue;
        seen++;
        if (this.store.upsertRecording(rec) === "new") added++;
      }
      if (rows.length < this.pageSize) break;
    }
    this.store.setMeta("full_walk_at", new Date().toISOString());
    this.store.setMeta("full_walk_seen", String(seen));
    log.info("full walk done", { seen, added, pages: page });
    await this.fetchMissingDetails();
    return { seen, added, pages: page };
  }

  /** Checks the newest page; fetches details for anything new. */
  async incremental(): Promise<{ added: number }> {
    const rows = listRows(await this.call("list_files", { page: 1, page_size: 50 }));
    let added = 0;
    for (const row of rows) {
      const rec = normaliseRecording(row);
      if (!rec) continue;
      if (this.store.upsertRecording(rec) === "new") added++;
    }
    this.store.setMeta("incremental_at", new Date().toISOString());
    if (added) log.info("new recordings", { added });
    await this.fetchMissingDetails();
    return { added };
  }

  /** Re-reads recent transcripts and notes to catch edits made in the Plaud app. */
  async sweep(days: number): Promise<{ checked: number; changed: number }> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    let changed = 0;
    const ids = this.store.recentIds(since);
    for (const id of ids) {
      if (await this.fetchDetail(id)) changed++;
    }
    this.store.setMeta("sweep_at", new Date().toISOString());
    log.info("edit sweep done", { checked: ids.length, changed, days });
    return { checked: ids.length, changed };
  }

  private async fetchMissingDetails() {
    for (const id of this.store.missingDetailIds()) {
      try {
        await this.fetchDetail(id);
      } catch (e) {
        log.warn("detail fetch failed", { id, error: (e as Error).message });
        if ((e as Error).name === "PlaudAuthError") throw e;
      }
    }
  }

  /** Fetches every transcript block and the notes for one recording. Returns true if anything changed. */
  async fetchDetail(id: string): Promise<boolean> {
    let changed = false;
    for (const block of BLOCKS) {
      const segments = await this.readBlock(id, block);
      if (segments === null) continue;
      if (this.store.putBlock(id, block, segments, contentHash(segments))) changed = true;
    }
    const notes = noteTabs(await this.call("get_note", { file_id: id }));
    if (this.store.putNotes(id, notes, contentHash(notes))) changed = true;
    return changed;
  }

  /** Reads all pages of one block; null when the recording has no such block. */
  private async readBlock(id: string, block: Block) {
    const rows: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      let raw: unknown;
      try {
        raw = await this.call("get_transcript", {
          file_id: id,
          block,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        });
      } catch (e) {
        if ((e as Error).name === "PlaudAuthError") throw e;
        // mark_memo and outline are often absent; a missing block is not an error.
        if (page === 0) return null;
        throw e;
      }
      const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const list = o["segments"] ?? o["marks"] ?? o["outline"] ?? o["items"];
      if (!Array.isArray(list)) return page === 0 ? null : normaliseSegments(rows);
      rows.push(...list);
      const next = o["next_cursor"];
      if (typeof next !== "string" || !next) break;
      cursor = next;
    }
    return normaliseSegments(rows);
  }
}

/** One tab per note in Plaud's app (summary, templates, Ask Plaud, highlights). */
export function noteTabs(raw: unknown): NoteTab[] {
  const list = findNoteList(raw);
  const tabs: NoteTab[] = [];
  for (const n of list) {
    const text = String(n["data_content"] ?? n["content"] ?? n["markdown"] ?? n["text"] ?? "").trim();
    if (!text) continue;
    const title = String(n["data_tab_name"] ?? n["data_title"] ?? n["title"] ?? n["data_type"] ?? "Note");
    tabs.push({ title, text });
  }
  return tabs;
}

function findNoteList(raw: unknown, depth = 0): Array<Record<string, unknown>> {
  if (!raw || depth > 3) return [];
  if (typeof raw === "string") return raw.trim() ? [{ content: raw }] : [];
  if (Array.isArray(raw)) return raw.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of ["note_list", "notes", "data", "items"]) {
      if (k in o) return findNoteList(o[k], depth + 1);
    }
    if ("data_content" in o || "content" in o) return [o];
  }
  return [];
}
