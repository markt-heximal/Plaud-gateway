/**
 * Sign-in to Plaud's official MCP server (https://mcp.plaud.ai/mcp): OAuth 2.1
 * with PKCE and dynamic client registration. The same flow coach4me uses, but
 * for one account, with the tokens in a mode-600 file under the state dir.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

import type { Config } from "./config.ts";
import { log } from "./log.ts";

export const PLAUD_ISSUER = "https://mcp.plaud.ai";
export const PLAUD_RESOURCE = `${PLAUD_ISSUER}/mcp`;

export class PlaudAuthError extends Error {
  constructor(message = "Plaud sign-in has expired or was revoked. Run `auth` again.") {
    super(message);
    this.name = "PlaudAuthError";
  }
}

export interface OAuthState {
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}

const b64url = (buf: Buffer) => buf.toString("base64url");
export const pkceChallenge = (verifier: string) =>
  b64url(createHash("sha256").update(verifier).digest());

/* ------------------------------------------------------------------ */
/* Token file                                                          */
/* ------------------------------------------------------------------ */

export class TokenFile {
  readonly path: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, "oauth.json");
  }

  read(): OAuthState | null {
    if (!existsSync(this.path)) return null;
    return JSON.parse(readFileSync(this.path, "utf8")) as OAuthState;
  }

  write(state: OAuthState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

async function registerClient(redirectUri: string) {
  const res = await fetch(`${PLAUD_ISSUER}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "plaud-gateway (ai-factory-mini)",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`Plaud refused the client registration (${res.status}).`);
  const json = (await res.json()) as { client_id?: string; client_secret?: string };
  if (!json.client_id) throw new Error("Plaud returned no client id.");
  return { clientId: json.client_id, clientSecret: json.client_secret ?? null };
}

async function tokenRequest(
  params: Record<string, string>,
  client: { clientId: string; clientSecret: string | null },
) {
  const body = new URLSearchParams({ ...params, client_id: client.clientId, resource: PLAUD_RESOURCE });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const res = await fetch(`${PLAUD_ISSUER}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (res.status === 400 || res.status === 401) throw new PlaudAuthError();
  if (!res.ok) throw new Error(`Plaud token request failed (${res.status}).`);
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) throw new PlaudAuthError();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? params["refresh_token"] ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
  };
}

/* ------------------------------------------------------------------ */
/* Live access token                                                   */
/* ------------------------------------------------------------------ */

/** Hands out a live access token, refreshing it a minute before it expires. */
export class TokenSource {
  private readonly file: TokenFile;
  constructor(stateDir: string) {
    this.file = new TokenFile(stateDir);
  }

  async get(forceRefresh = false): Promise<string> {
    const s = this.file.read();
    if (!s) throw new PlaudAuthError("Not signed in to Plaud. Run `auth` first.");
    const expiring = s.expiresAt !== null && Date.parse(s.expiresAt) - Date.now() < 60_000;
    if (!forceRefresh && !expiring) return s.accessToken;
    if (!s.refreshToken) throw new PlaudAuthError();
    const t = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: s.refreshToken },
      { clientId: s.clientId, clientSecret: s.clientSecret },
    );
    this.file.write({ ...s, ...t });
    log.info("plaud token refreshed", { expiresAt: t.expiresAt });
    return t.accessToken;
  }
}

/* ------------------------------------------------------------------ */
/* One-time interactive sign-in                                        */
/* ------------------------------------------------------------------ */

/**
 * Prints a sign-in link and waits on a loopback callback for Plaud's redirect.
 * Run it on the mini (or through `ssh -L <port>:127.0.0.1:<port>`), open the
 * link in a browser, and approve.
 */
export async function interactiveAuth(config: Config): Promise<void> {
  const redirectUri = `http://127.0.0.1:${config.authPort}/callback`;
  const client = await registerClient(redirectUri);
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const url = new URL(`${PLAUD_ISSUER}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", PLAUD_RESOURCE);

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const reply = (status: number, text: string) => {
        res.writeHead(status, { "Content-Type": "text/plain" });
        res.end(text);
      };
      const error = u.searchParams.get("error");
      if (error) {
        // Plaud refused (e.g. access_denied): that is final.
        const why = [error, u.searchParams.get("error_description")].filter(Boolean).join(": ");
        reply(400, `Plaud did not grant access (${why}). Run auth again to retry.`);
        clearTimeout(timer);
        server.close();
        reject(new Error(`Plaud did not grant access: ${why}`));
        return;
      }
      const got = u.searchParams.get("code");
      if (!got || u.searchParams.get("state") !== state) {
        // A stray or stale redirect (an older link, a reload, a prefetch):
        // say so and keep waiting for the real one.
        const reason = !got ? "it carried no approval code" : "it came from a different sign-in link";
        console.log(`Ignored a redirect to the callback: ${reason}. Still waiting.`);
        reply(
          400,
          `This page isn't from the current sign-in link (${reason}). Use the newest link the gateway printed.`,
        );
        return;
      }
      reply(200, "Signed in to Plaud. You can close this tab.");
      clearTimeout(timer);
      server.close();
      resolve(got);
    });
    // Give up after 15 minutes so a forgotten sign-in doesn't hold the port.
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("No approval within 15 minutes. Run auth again for a fresh link."));
    }, 15 * 60_000);
    server.listen(config.authPort, "127.0.0.1", () => {
      console.log(`\nOpen this link in a browser on this machine and approve access:\n\n${url}\n`);
      console.log(
        `(From another machine: ssh -L ${config.authPort}:127.0.0.1:${config.authPort} <this host>, then open it there.)\n`,
      );
    });
  });

  const tokens = await tokenRequest(
    { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri },
    client,
  );
  new TokenFile(config.stateDir).write({ ...client, redirectUri, ...tokens });
  console.log("Saved. The gateway can now read your Plaud library.");
}
