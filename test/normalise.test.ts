import assert from "node:assert/strict";
import { test } from "node:test";

import { isGenericSpeaker, msToSeconds, normaliseRecording, normaliseSegments, toIsoUtc } from "../src/normalise.ts";

test("zone-less Plaud times are UTC, with microseconds trimmed", () => {
  assert.equal(toIsoUtc("2026-09-23T16:09:44"), "2026-09-23T16:09:44.000Z");
  assert.equal(toIsoUtc("2026-09-23T15:00:01.493000"), "2026-09-23T15:00:01.493Z");
  assert.equal(toIsoUtc("2025-11-17T19:32:55.000Z"), "2025-11-17T19:32:55.000Z");
  assert.equal(toIsoUtc(1758800000000), new Date(1758800000000).toISOString());
  assert.equal(toIsoUtc("not a date"), null);
});

test("durations are milliseconds, even for short clips", () => {
  assert.equal(msToSeconds(3000), 3);
  assert.equal(msToSeconds(54_000), 54);
  assert.equal(msToSeconds(2_307_000), 2307);
  assert.equal(msToSeconds(200), 1);
  assert.equal(msToSeconds(0), null);
});

test("list rows become recordings", () => {
  assert.deepEqual(
    normaliseRecording({
      id: "of_e7e5",
      name: "2026-09-23 18:09:44",
      created_at: "2026-09-24T14:04:38",
      serial_number: null,
      start_at: "2026-09-23T16:09:44",
      duration: 3000,
    }),
    {
      id: "of_e7e5",
      name: "2026-09-23 18:09:44",
      startedAt: "2026-09-23T16:09:44.000Z",
      createdAt: "2026-09-24T14:04:38.000Z",
      durationSec: 3,
      serialNumber: null,
    },
  );
  assert.equal(normaliseRecording({ name: "no id" }), null);
});

test("segments keep the current and original speaker", () => {
  const [s] = normaliseSegments([
    { start_time: 19940, end_time: 23620, content: " Are you in Berlin? ", speaker: "Tarkan", original_speaker: "Speaker 2" },
    { start_time: 1, content: "" },
  ]);
  assert.deepEqual(s, { startMs: 19940, endMs: 23620, speaker: "Tarkan", originalSpeaker: "Speaker 2", text: "Are you in Berlin?" });
});

test("generic speaker labels", () => {
  assert.ok(isGenericSpeaker("Speaker 3"));
  assert.ok(!isGenericSpeaker("Tarkan"));
});
