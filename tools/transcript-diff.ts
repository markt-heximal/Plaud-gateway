/**
 * Compares two transcript snapshots and says what changed, block by block.
 * Used by docs/writeback-test.md to judge a speaker rename made through
 * Plaud's private API.
 */
import type { Segment } from "../src/normalise.ts";

export interface Snapshot {
  id: string;
  takenAt: string;
  blocks: Record<string, Segment[] | null>;
}

export interface BlockDiff {
  block: string;
  present: [boolean, boolean];
  segments: [number, number];
  /** Speaker label changes, as "old -> new" with how many segments. */
  speakerChanges: Record<string, number>;
  textChanges: number;
  timeChanges: number;
}

export function diffBlock(block: string, a: Segment[] | null, b: Segment[] | null): BlockDiff {
  const d: BlockDiff = {
    block,
    present: [a !== null, b !== null],
    segments: [a?.length ?? 0, b?.length ?? 0],
    speakerChanges: {},
    textChanges: 0,
    timeChanges: 0,
  };
  if (!a || !b) return d;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.speaker !== y.speaker) {
      const k = `${x.speaker} -> ${y.speaker}`;
      d.speakerChanges[k] = (d.speakerChanges[k] ?? 0) + 1;
    }
    if (x.text !== y.text) d.textChanges++;
    if (x.startMs !== y.startMs || x.endMs !== y.endMs) d.timeChanges++;
  }
  return d;
}

/** A verdict in plain words for each block. */
export function verdict(d: BlockDiff): string {
  if (!d.present[0] && !d.present[1]) return "absent before and after";
  if (d.present[0] !== d.present[1]) return d.present[1] ? "APPEARED" : "DISAPPEARED";
  const renames = Object.keys(d.speakerChanges);
  const other =
    d.segments[0] !== d.segments[1] || d.textChanges > 0 || d.timeChanges > 0 || renames.length > 1;
  if (renames.length === 0 && !other) return "unchanged";
  if (renames.length === 1 && !other) return `only the speaker changed: ${renames[0]}`;
  return "CHANGED BEYOND THE RENAME: see the counts";
}
