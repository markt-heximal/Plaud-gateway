import assert from "node:assert/strict";
import { test } from "node:test";

import { Store } from "../src/store.ts";
import { noteTabs, Syncer } from "../src/sync.ts";
import { FakePlaud, sampleLibrary } from "./fake-plaud.ts";

const setup = (pageSize = 2) => {
  const plaud = new FakePlaud(sampleLibrary());
  const store = new Store(":memory:");
  return { plaud, store, syncer: new Syncer(plaud, store, { callDelayMs: 0, pageSize }) };
};

test("the full walk pages through the whole library", async () => {
  const { plaud, store, syncer } = setup(2);
  const r = await syncer.fullWalk();
  assert.deepEqual(r, { seen: 3, added: 3, pages: 2 });
  const lists = plaud.calls.filter((c) => c.tool === "list_files");
  assert.deepEqual(lists.map((c) => c.args["page"]), [1, 2]);
  const c = store.counts();
  assert.equal(c.recordings, 3);
  assert.equal(c.oldest, "2026-06-23T19:07:25.048Z");
  assert.equal(c.withCleanedTranscript, 1);
  assert.equal(c.withRawTranscript, 3);
  assert.equal(c.withNotes, 3);
  assert.ok(store.getMeta("heartbeat"), "every Plaud call records a heartbeat for the healthcheck");
});

test("the cleaned-up transcript is preferred and carries renames", async () => {
  const { store, syncer } = setup();
  await syncer.fullWalk();
  const t = store.preferredTranscript("of_a1")!;
  assert.equal(t.block, "transaction_polish");
  assert.deepEqual(
    store.speakers("of_a1").map((s) => [s.label, s.name, s.source]),
    [
      ["Mark", "Mark", "plaud"],
      ["Tarkan", "Tarkan", "plaud"],
      ["Speaker 3", "Speaker 3", null],
    ],
  );
  assert.equal(store.preferredTranscript("of_b2")!.block, "transaction");
});

test("long transcripts are read across pages", async () => {
  const { plaud, store, syncer } = setup();
  plaud.library[0]!.polish = Array.from({ length: 1203 }, (_, i) => ({
    start_time: i * 1000,
    speaker: "Mark",
    original_speaker: "Speaker 1",
    content: `line ${i}`,
  }));
  await syncer.fullWalk();
  assert.equal(store.getBlock("of_a1", "transaction_polish")!.length, 1203);
});

test("the sweep records edits made in the Plaud app, and only those", async () => {
  const { plaud, store, syncer } = setup();
  await syncer.fullWalk();
  const before = store.counts().lastChange;

  const quiet = await syncer.sweep(3650);
  assert.equal(quiet.changed, 0);
  assert.equal(store.counts().lastChange, before);

  plaud.library[0]!.polish![2]!.speaker = "Tarkan"; // renamed in the Plaud app
  const r = await syncer.sweep(3650);
  assert.equal(r.changed, 1);
  const changes = store.changesSince(before, 10);
  assert.deepEqual(
    changes.map((c) => [c.recordingId, c.kind, c.detail]),
    [["of_a1", "transcript", "transaction_polish"]],
  );
});

test("new recordings arrive on the incremental check", async () => {
  const { plaud, store, syncer } = setup();
  await syncer.fullWalk();
  plaud.library.push({
    id: "of_d4",
    name: "09-25 Board prep",
    start_at: "2026-09-25T09:00:00",
    duration: 600_000,
    raw: [{ start_time: 0, speaker: "Speaker 1", original_speaker: "Speaker 1", content: "Agenda first." }],
  });
  assert.deepEqual(await syncer.incremental(), { added: 1 });
  assert.equal(store.getRecording("of_d4")!.durationSec, 600);
  assert.ok(store.getBlock("of_d4", "transaction"));
});

test("title changes in Plaud are recorded", async () => {
  const { plaud, store, syncer } = setup();
  await syncer.fullWalk();
  const before = store.counts().lastChange;
  plaud.library[0]!.name = "09-24 Product and pricing review";
  await syncer.fullWalk();
  assert.equal(store.getRecording("of_a1")!.name, "09-24 Product and pricing review");
  assert.deepEqual(
    store.changesSince(before, 10).map((c) => [c.kind, c.detail]),
    [["metadata", "renamed"]],
  );
});

test("search covers titles, transcripts and notes across the whole library", async () => {
  const { store, syncer } = setup();
  await syncer.fullWalk();
  const ids = (q: string) => store.listRecordings({ q, limit: 50, offset: 0 }).recordings.map((r) => r.id);
  assert.deepEqual(ids("pricing"), ["of_a1"]);
  assert.deepEqual(ids("onboard"), ["of_c3"]);
  assert.deepEqual(ids("cohort"), ["of_c3"]);
  assert.deepEqual(ids("Tarkan"), ["of_a1"]);
  assert.deepEqual(ids("nothing-like-this"), []);
  assert.deepEqual(ids('"; DROP TABLE recordings; --'), []);
  const june = store.listRecordings({ from: "2026-06-01", to: "2026-06-30", limit: 50, offset: 0 });
  assert.deepEqual(june.recordings.map((r) => r.id), ["of_c3"]);
});

test("note tabs come from note_list", () => {
  assert.deepEqual(
    noteTabs({
      note_list: [
        { data_type: "auto_sum_note", data_title: "Summary", data_tab_name: "Summary", data_content: "Short." },
        { data_tab_name: "Empty", data_content: "" },
      ],
    }),
    [{ title: "Summary", text: "Short." }],
  );
});
