import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { test } from "node:test";

import { PlaudMcp } from "../src/mcp.ts";

test("MCP client: initialise, session id, SSE results and a refresh on 401", async () => {
  const seen: Array<{ method: string; session: string | null; auth: string | null }> = [];
  let rejectedOnce = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const msg = JSON.parse(body) as { id?: number; method: string };
    seen.push({
      method: msg.method,
      session: (req.headers["mcp-session-id"] as string) ?? null,
      auth: req.headers.authorization ?? null,
    });
    if (msg.method === "tools/call" && !rejectedOnce) {
      rejectedOnce = true;
      res.writeHead(401).end();
      return;
    }
    if (msg.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    const result =
      msg.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {} }
        : { content: [{ type: "text", text: JSON.stringify({ type: "list", data: [{ id: "of_1" }] }) }] };
    res.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "sess-1" });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

  let token = "old";
  let refreshes = 0;
  const mcp = new PlaudMcp(async (force) => {
    if (force) {
      refreshes++;
      token = "new";
    }
    return token;
  }, url);

  const out = await mcp.call("list_files", { page: 1 });
  server.close();

  assert.deepEqual(out, { type: "list", data: [{ id: "of_1" }] });
  assert.equal(refreshes, 1);
  assert.deepEqual(
    seen.map((s) => [s.method, s.session, s.auth]),
    [
      ["initialize", null, "Bearer old"],
      ["notifications/initialized", "sess-1", "Bearer old"],
      ["tools/call", "sess-1", "Bearer old"],
      ["tools/call", "sess-1", "Bearer new"],
    ],
  );
});
