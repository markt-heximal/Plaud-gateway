/**
 * Plaud's quirks, handled once (ADR 7, Decision 3). Measured on the live
 * account on 2026-09-25:
 * - `duration` is always milliseconds, even for a 3-second clip.
 * - `start_at` / `created_at` are UTC with no zone suffix, sometimes with six
 *   fractional digits ("2026-09-23T15:00:01.493000").
 * - Transcript segments carry `speaker` (the current name, possibly renamed in
 *   the Plaud app) and `original_speaker` ("Speaker 2"), with times in ms.
 */
import { createHash } from "node:crypto";

export interface Recording {
  id: string;
  name: string;
  startedAt: string | null;
  createdAt: string | null;
  durationSec: number | null;
  serialNumber: string | null;
}

export interface Segment {
  startMs: number | null;
  endMs: number | null;
  speaker: string;
  originalSpeaker: string | null;
  text: string;
}

/** Transcript blocks, in the order the gateway prefers them. */
export const BLOCKS = ["transaction_polish", "transaction", "outline", "mark_memo"] as const;
export type Block = (typeof BLOCKS)[number];

/** Parses a Plaud time as UTC. Zone-less strings are UTC, not server-local. */
export function toIsoUtc(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return new Date(v > 1e12 ? v : v * 1000).toISOString();
  }
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim();
  if (/^\d+$/.test(s)) return toIsoUtc(Number(s));
  // Microseconds: keep milliseconds, drop the rest, so Date parses it everywhere.
  s = s.replace(/(\.\d{3})\d+/, "$1");
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += "Z";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Plaud durations are milliseconds; returns whole seconds (at least 1). */
export function msToSeconds(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n / 1000));
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));

export function normaliseRecording(row: Record<string, unknown>): Recording | null {
  const id = str(row["id"] ?? row["file_id"]);
  if (!id) return null;
  return {
    id,
    name: (str(row["name"] ?? row["filename"] ?? row["title"]) ?? "").trim() || "Untitled recording",
    startedAt: toIsoUtc(row["start_at"] ?? row["start_time"]),
    createdAt: toIsoUtc(row["created_at"]),
    durationSec: msToSeconds(row["duration"]),
    serialNumber: str(row["serial_number"]),
  };
}

/** The rows of a list_files response (browse or filtered). */
export function listRows(raw: unknown): Array<Record<string, unknown>> {
  if (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)) {
    return (raw as { data: Array<Record<string, unknown>> }).data;
  }
  return [];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function normaliseSegments(rows: unknown[]): Segment[] {
  const out: Segment[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const text = (str(o["content"] ?? o["text"] ?? o["topic"]) ?? "").trim();
    if (!text) continue;
    out.push({
      startMs: num(o["start_time"]),
      endMs: num(o["end_time"]),
      speaker: (str(o["speaker"]) ?? str(o["original_speaker"]) ?? "").trim(),
      originalSpeaker: str(o["original_speaker"]),
      text,
    });
  }
  return out;
}

const GENERIC_SPEAKER = /^(speaker|spk|sprecher|intervenant|hablante)\s*[A-Z0-9]{1,3}$/i;
/** True for placeholder labels like "Speaker 2" that no one has renamed. */
export const isGenericSpeaker = (label: string) => GENERIC_SPEAKER.test(label.trim());

/** Stable hash of what a reader would see; used to detect edits made in the Plaud app. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
