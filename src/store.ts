/**
 * The local copy of the library: one SQLite file in the state dir. Faithful to
 * Plaud (ADR 7, Decision 8); the only thing of mine in it is speaker fixes.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Block, Recording, Segment } from "./normalise.ts";
import { isGenericSpeaker } from "./normalise.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  started_at TEXT,
  created_at TEXT,
  duration_sec INTEGER,
  serial_number TEXT,
  first_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recordings_started ON recordings (started_at);
CREATE TABLE IF NOT EXISTS blocks (
  recording_id TEXT NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  block TEXT NOT NULL,
  segments_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (recording_id, block)
);
CREATE TABLE IF NOT EXISTS notes (
  recording_id TEXT PRIMARY KEY REFERENCES recordings (id) ON DELETE CASCADE,
  notes_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS speaker_fixes (
  recording_id TEXT NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (recording_id, label)
);
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5 (
  recording_id UNINDEXED, name, transcript, notes, tokenize = 'unicode61 remove_diacritics 2'
);
`;

export interface NoteTab {
  title: string;
  text: string;
}

export interface SpeakerView {
  label: string;
  name: string;
  source: "plaud" | "fix" | null;
  turns: number;
}

export interface Change {
  seq: number;
  recordingId: string;
  kind: string;
  detail: string | null;
  at: string;
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    if (path !== ":memory:" && existsSync(path)) chmodSync(path, 0o600);
  }

  static open(stateDir: string): Store {
    return new Store(join(stateDir, "plaud.db"));
  }

  close() {
    this.db.close();
  }

  private change(recordingId: string, kind: string, detail: string | null = null) {
    this.db
      .prepare("INSERT INTO changes (recording_id, kind, detail, at) VALUES (?, ?, ?, ?)")
      .run(recordingId, kind, detail, now());
  }

  /* -------- meta -------- */

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return r ? String(r["value"]) : null;
  }

  setMeta(key: string, value: string) {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /* -------- recordings -------- */

  has(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM recordings WHERE id = ?").get(id) !== undefined;
  }

  /** Inserts or updates metadata. Returns "new", "updated" or "same". */
  upsertRecording(r: Recording): "new" | "updated" | "same" {
    const old = this.db.prepare("SELECT * FROM recordings WHERE id = ?").get(r.id) as Row | undefined;
    const t = now();
    if (!old) {
      this.db
        .prepare(
          `INSERT INTO recordings (id, name, started_at, created_at, duration_sec, serial_number, first_seen, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.id, r.name, r.startedAt, r.createdAt, r.durationSec, r.serialNumber, t, t);
      this.change(r.id, "new");
      this.reindex(r.id);
      return "new";
    }
    const same =
      old["name"] === r.name &&
      old["started_at"] === r.startedAt &&
      old["duration_sec"] === r.durationSec &&
      (old["serial_number"] ?? null) === r.serialNumber;
    if (same) return "same";
    this.db
      .prepare(
        `UPDATE recordings SET name = ?, started_at = ?, created_at = ?, duration_sec = ?, serial_number = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(r.name, r.startedAt, r.createdAt, r.durationSec, r.serialNumber, t, r.id);
    this.change(r.id, "metadata", old["name"] !== r.name ? "renamed" : null);
    this.reindex(r.id);
    return "updated";
  }

  getRecording(id: string): Recording | null {
    const r = this.db.prepare("SELECT * FROM recordings WHERE id = ?").get(id) as Row | undefined;
    return r ? toRecording(r) : null;
  }

  /** Newest first. `q` is a full-text search over titles, transcripts and notes. */
  listRecordings(f: { q?: string; from?: string; to?: string; limit: number; offset: number }): {
    recordings: Recording[];
    total: number;
  } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (f.q) {
      where.push("r.id IN (SELECT recording_id FROM search WHERE search MATCH ?)");
      args.push(ftsQuery(f.q));
    }
    if (f.from) {
      where.push("r.started_at >= ?");
      args.push(`${f.from}T00:00:00.000Z`);
    }
    if (f.to) {
      where.push("r.started_at <= ?");
      args.push(`${f.to}T23:59:59.999Z`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(
      (this.db.prepare(`SELECT count(*) AS n FROM recordings r ${clause}`).get(...args) as Row)["n"],
    );
    const rows = this.db
      .prepare(`SELECT * FROM recordings r ${clause} ORDER BY r.started_at DESC, r.id LIMIT ? OFFSET ?`)
      .all(...args, f.limit, f.offset) as Row[];
    return { recordings: rows.map(toRecording), total };
  }

  /** Recordings started on or after `sinceIso`, for the edit sweep. */
  recentIds(sinceIso: string): string[] {
    return (
      this.db.prepare("SELECT id FROM recordings WHERE started_at >= ? ORDER BY started_at DESC").all(sinceIso) as Row[]
    ).map((r) => String(r["id"]));
  }

  missingDetailIds(): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM recordings r WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.recording_id = r.id)
           ORDER BY started_at DESC`,
        )
        .all() as Row[]
    ).map((r) => String(r["id"]));
  }

  counts() {
    const one = (sql: string) => this.db.prepare(sql).get() as Row;
    const r = one("SELECT count(*) AS n, min(started_at) AS oldest, max(started_at) AS newest FROM recordings");
    return {
      recordings: Number(r["n"]),
      oldest: (r["oldest"] as string | null) ?? null,
      newest: (r["newest"] as string | null) ?? null,
      withCleanedTranscript: Number(one("SELECT count(*) AS n FROM blocks WHERE block = 'transaction_polish'")["n"]),
      withRawTranscript: Number(one("SELECT count(*) AS n FROM blocks WHERE block = 'transaction'")["n"]),
      withNotes: Number(one("SELECT count(*) AS n FROM notes")["n"]),
      lastChange: Number(one("SELECT coalesce(max(seq), 0) AS n FROM changes")["n"]),
    };
  }

  /* -------- transcripts and notes -------- */

  /** Stores a block. Returns true when it is new or its content changed. */
  putBlock(id: string, block: Block, segments: Segment[], hash: string): boolean {
    const old = this.db
      .prepare("SELECT hash FROM blocks WHERE recording_id = ? AND block = ?")
      .get(id, block) as Row | undefined;
    if (old && old["hash"] === hash) {
      this.db.prepare("UPDATE blocks SET fetched_at = ? WHERE recording_id = ? AND block = ?").run(now(), id, block);
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO blocks (recording_id, block, segments_json, hash, fetched_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (recording_id, block) DO UPDATE SET segments_json = excluded.segments_json,
           hash = excluded.hash, fetched_at = excluded.fetched_at`,
      )
      .run(id, block, JSON.stringify(segments), hash, now());
    if (old) this.change(id, "transcript", block);
    this.reindex(id);
    return true;
  }

  getBlock(id: string, block: Block): Segment[] | null {
    const r = this.db
      .prepare("SELECT segments_json FROM blocks WHERE recording_id = ? AND block = ?")
      .get(id, block) as Row | undefined;
    return r ? (JSON.parse(String(r["segments_json"])) as Segment[]) : null;
  }

  blocksFor(id: string): Block[] {
    return (
      this.db.prepare("SELECT block FROM blocks WHERE recording_id = ?").all(id) as Row[]
    ).map((r) => r["block"] as Block);
  }

  putNotes(id: string, notes: NoteTab[], hash: string): boolean {
    const old = this.db.prepare("SELECT hash FROM notes WHERE recording_id = ?").get(id) as Row | undefined;
    if (old && old["hash"] === hash) {
      this.db.prepare("UPDATE notes SET fetched_at = ? WHERE recording_id = ?").run(now(), id);
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO notes (recording_id, notes_json, hash, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (recording_id) DO UPDATE SET notes_json = excluded.notes_json, hash = excluded.hash,
           fetched_at = excluded.fetched_at`,
      )
      .run(id, JSON.stringify(notes), hash, now());
    if (old) this.change(id, "notes");
    this.reindex(id);
    return true;
  }

  getNotes(id: string): NoteTab[] | null {
    const r = this.db.prepare("SELECT notes_json FROM notes WHERE recording_id = ?").get(id) as Row | undefined;
    return r ? (JSON.parse(String(r["notes_json"])) as NoteTab[]) : null;
  }

  /** The cleaned-up transcript when Plaud has one, else the raw one (ADR 7, Decision 3). */
  preferredTranscript(id: string): { block: Block; segments: Segment[] } | null {
    for (const block of ["transaction_polish", "transaction"] as const) {
      const segments = this.getBlock(id, block);
      if (segments?.length) return { block, segments };
    }
    return null;
  }

  /* -------- speakers -------- */

  setSpeakerFix(id: string, label: string, name: string | null) {
    if (name) {
      this.db
        .prepare(
          `INSERT INTO speaker_fixes (recording_id, label, name, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (recording_id, label) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
        )
        .run(id, label, name, now());
    } else {
      this.db.prepare("DELETE FROM speaker_fixes WHERE recording_id = ? AND label = ?").run(id, label);
    }
    this.change(id, "speaker_fix", label);
  }

  /** Speakers in the preferred transcript. A name set in Plaud wins over a local fix. */
  speakers(id: string): SpeakerView[] {
    const t = this.preferredTranscript(id);
    if (!t) return [];
    const fixes = new Map(
      (this.db.prepare("SELECT label, name FROM speaker_fixes WHERE recording_id = ?").all(id) as Row[]).map((r) => [
        String(r["label"]),
        String(r["name"]),
      ]),
    );
    const turns = new Map<string, number>();
    for (const s of t.segments) turns.set(s.speaker, (turns.get(s.speaker) ?? 0) + 1);
    return [...turns].map(([label, n]) => {
      if (!isGenericSpeaker(label)) return { label, name: label, source: "plaud", turns: n };
      const fix = fixes.get(label);
      return fix ? { label, name: fix, source: "fix", turns: n } : { label, name: label, source: null, turns: n };
    });
  }

  /* -------- changes -------- */

  changesSince(seq: number, limit: number): Change[] {
    return (
      this.db.prepare("SELECT * FROM changes WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as Row[]
    ).map((r) => ({
      seq: Number(r["seq"]),
      recordingId: String(r["recording_id"]),
      kind: String(r["kind"]),
      detail: (r["detail"] as string | null) ?? null,
      at: String(r["at"]),
    }));
  }

  /* -------- search index -------- */

  private reindex(id: string) {
    const rec = this.db.prepare("SELECT name FROM recordings WHERE id = ?").get(id) as Row | undefined;
    if (!rec) return;
    const t = this.preferredTranscript(id);
    const notes = this.getNotes(id) ?? [];
    this.db.prepare("DELETE FROM search WHERE recording_id = ?").run(id);
    this.db
      .prepare("INSERT INTO search (recording_id, name, transcript, notes) VALUES (?, ?, ?, ?)")
      .run(
        id,
        String(rec["name"]),
        (t?.segments ?? []).map((s) => `${s.speaker}: ${s.text}`).join("\n"),
        notes.map((n) => `${n.title}\n${n.text}`).join("\n\n"),
      );
  }
}

function toRecording(r: Row): Recording {
  return {
    id: String(r["id"]),
    name: String(r["name"]),
    startedAt: (r["started_at"] as string | null) ?? null,
    createdAt: (r["created_at"] as string | null) ?? null,
    durationSec: r["duration_sec"] == null ? null : Number(r["duration_sec"]),
    serialNumber: (r["serial_number"] as string | null) ?? null,
  };
}

/** Turns free text into a safe FTS5 query: every word must appear, as a prefix. */
export function ftsQuery(q: string): string {
  const words = q.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : '""';
}
