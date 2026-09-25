/**
 * A stand-in for Plaud's MCP connector, returning the response shapes the live
 * connector returned on 2026-09-25. The content is invented.
 */
import type { PlaudSource } from "../src/mcp.ts";

export interface FakeRecording {
  id: string;
  name: string;
  start_at: string;
  duration: number;
  raw: Array<{ start_time: number; speaker: string; original_speaker: string; content: string }>;
  polish?: Array<{ start_time: number; speaker: string; original_speaker: string; content: string }>;
  notes?: Array<{ data_tab_name: string; data_content: string }>;
}

export class FakePlaud implements PlaudSource {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  library: FakeRecording[];
  constructor(library: FakeRecording[]) {
    this.library = library;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ tool, args });
    const byNewest = [...this.library].sort((a, b) => b.start_at.localeCompare(a.start_at));
    if (tool === "list_files") {
      const page = Number(args["page"] ?? 1);
      const size = Number(args["page_size"] ?? 20);
      const data = byNewest.slice((page - 1) * size, page * size).map((r) => ({
        id: r.id,
        name: r.name,
        created_at: r.start_at,
        serial_number: null,
        start_at: r.start_at,
        duration: r.duration,
      }));
      return { type: "list", data, page, page_size: size };
    }
    const rec = this.library.find((r) => r.id === args["file_id"]);
    if (!rec) throw new Error(`Plaud get: not found`);
    if (tool === "get_transcript") {
      const block = args["block"] ?? "transaction";
      const rows = block === "transaction" ? rec.raw : block === "transaction_polish" ? rec.polish : undefined;
      if (!rows) throw new Error(`Plaud get_transcript: block ${String(block)} not present`);
      const limit = Number(args["limit"] ?? 50);
      const offset = args["cursor"] ? Number(args["cursor"]) : 0;
      const segments = rows.slice(offset, offset + limit).map((s) => ({ ...s, end_time: s.start_time + 1000 }));
      const next = offset + limit < rows.length ? String(offset + limit) : null;
      return { file_id: rec.id, block, total: rows.length, offset, limit, returned: segments.length, next_cursor: next, segments };
    }
    if (tool === "get_note") {
      return { note_list: rec.notes ?? [] };
    }
    throw new Error(`unexpected tool ${tool}`);
  }
}

export function sampleLibrary(): FakeRecording[] {
  return [
    {
      id: "of_a1",
      name: "09-24 Product review",
      start_at: "2026-09-24T13:05:49",
      duration: 2_307_000,
      raw: [
        { start_time: 7860, speaker: "Mark", original_speaker: "Speaker 1", content: "Let's start with the roadmap." },
        { start_time: 19940, speaker: "Hamid", original_speaker: "Speaker 2", content: "Pricing is the open item." },
        { start_time: 30000, speaker: "Speaker 3", original_speaker: "Speaker 3", content: "Agreed, pricing first." },
      ],
      polish: [
        { start_time: 7860, speaker: "Mark", original_speaker: "Speaker 1", content: "Let's start with the roadmap." },
        { start_time: 19940, speaker: "Tarkan", original_speaker: "Speaker 2", content: "Pricing is the open item." },
        { start_time: 30000, speaker: "Speaker 3", original_speaker: "Speaker 3", content: "Agreed, pricing first." },
      ],
      notes: [{ data_tab_name: "Summary", data_content: "Pricing decision moves to next week." }],
    },
    {
      id: "of_b2",
      name: "2026-09-23 18:09:44",
      start_at: "2026-09-23T16:09:44",
      duration: 3000,
      raw: [{ start_time: 0, speaker: "Speaker 1", original_speaker: "Speaker 1", content: "Yes, I can." }],
    },
    {
      id: "of_c3",
      name: "06-23 Onboarding",
      start_at: "2026-06-23T19:07:25.048000",
      duration: 3_119_000,
      raw: [{ start_time: 0, speaker: "Speaker 1", original_speaker: "Speaker 1", content: "Welcome aboard." }],
      notes: [{ data_tab_name: "Summary", data_content: "First week plan for the onboarding cohort." }],
    },
  ];
}
