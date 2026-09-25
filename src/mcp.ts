/**
 * Plaud's official MCP server over Streamable HTTP. Read-only by design: the
 * server offers list_files, get_file, get_transcript, get_note and
 * get_current_user, and this client only ever calls those.
 */
import { PLAUD_RESOURCE, PlaudAuthError } from "./oauth.ts";

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** What the sync needs from Plaud. Tests supply a fake. */
export interface PlaudSource {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export class PlaudMcp implements PlaudSource {
  private sessionId: string | null = null;
  private nextId = 1;
  private connected = false;

  private readonly token: (forceRefresh?: boolean) => Promise<string>;
  private readonly endpoint: string;

  constructor(token: (forceRefresh?: boolean) => Promise<string>, endpoint = PLAUD_RESOURCE) {
    this.token = token;
    this.endpoint = endpoint;
  }

  private async post(body: unknown, retried = false): Promise<JsonRpcResponse | null> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.token()}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const res = await fetch(this.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    if (res.status === 401 && !retried) {
      await this.token(true);
      return this.post(body, true);
    }
    if (res.status === 401 || res.status === 403) throw new PlaudAuthError();
    if (res.status === 404 && this.sessionId) {
      // The server dropped our session; start a new one.
      this.sessionId = null;
      this.connected = false;
      throw new Error("Plaud MCP session expired.");
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return null;
    if (!res.ok) throw new Error(`Plaud MCP responded ${res.status}.`);

    const text = await res.text();
    if (!(res.headers.get("content-type") ?? "").includes("event-stream")) {
      return text ? (JSON.parse(text) as JsonRpcResponse) : null;
    }
    const wanted = (body as { id?: number }).id;
    let found: JsonRpcResponse | null = null;
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as JsonRpcResponse;
        if (msg.id === wanted) found = msg;
      } catch {
        /* keep-alives */
      }
    }
    return found;
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    if (!res) throw new Error(`Plaud MCP sent no reply to ${method}.`);
    if (res.error) {
      if (/auth|token|unauthor/i.test(res.error.message)) throw new PlaudAuthError();
      throw new Error(`Plaud MCP ${method}: ${res.error.message}`);
    }
    return res.result;
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "plaud-gateway", version: "0.1.0" },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.connected = true;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const res = (await this.request("tools/call", { name: tool, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
    if (res.isError) {
      if (/auth|token|log ?in|unauthor/i.test(text)) throw new PlaudAuthError();
      throw new Error(`Plaud ${tool}: ${text || "failed"}`);
    }
    if (res.structuredContent !== undefined) return res.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
