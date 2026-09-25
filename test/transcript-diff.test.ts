import assert from "node:assert/strict";
import { test } from "node:test";

import type { Segment } from "../src/normalise.ts";
import { diffBlock, verdict } from "../tools/transcript-diff.ts";

const seg = (speaker: string, text: string, startMs = 0): Segment => ({
  startMs,
  endMs: startMs + 1000,
  speaker,
  originalSpeaker: "Speaker 1",
  text,
});
const before = [seg("Speaker 1", "Testing one two", 0), seg("Speaker 1", "three four", 1000)];

test("a clean rename is reported as only the speaker changing", () => {
  const after = before.map((s) => ({ ...s, speaker: "Test Name" }));
  const d = diffBlock("transaction", before, after);
  assert.deepEqual(d.speakerChanges, { "Speaker 1 -> Test Name": 2 });
  assert.equal(verdict(d), "only the speaker changed: Speaker 1 -> Test Name");
});

test("no change, and text damage, are told apart", () => {
  assert.equal(verdict(diffBlock("transaction_polish", before, before)), "unchanged");
  const damaged = [before[0]!, { ...before[1]!, text: "three" }];
  assert.equal(verdict(diffBlock("transaction", before, damaged)), "CHANGED BEYOND THE RENAME: see the counts");
  assert.equal(verdict(diffBlock("transaction", before, before.slice(0, 1))), "CHANGED BEYOND THE RENAME: see the counts");
  assert.equal(verdict(diffBlock("transaction_polish", before, null)), "DISAPPEARED");
});
