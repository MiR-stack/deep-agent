// mcp-oauth.ts
// Reusable, server-agnostic OAuth for MCP clients (browser login, local callback).
//
//  - Works with any MCP server that follows the MCP authorization spec:
//      discovery (RFC 9728 + RFC 8414) -> client registration -> PKCE -> token.
//  - Dynamic client registration is used automatically when the server supports it.
//    Servers that don't (e.g. GitHub) take a pre-registered clientId/clientSecret.
//  - Tokens + registered client info are cached per server in one JSON file.
import fs from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import open from "open";
import type { Connection } from "@langchain/mcp-adapters";
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
  type OAuthClientMetadata,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

// ---------------------------------------------------------------------------
// Public config types
// ---------------------------------------------------------------------------
export type OAuthOptions = {
  /** Only for servers WITHOUT dynamic client registration (e.g. GitHub). */
  clientId?: string;
  clientSecret?: string;
  /** Space-separated scopes. Omit to let the server decide. */
  scope?: string;
  /** Loopback callback port. Default 8765. */
  port?: number;
};

export type McpServerSpec =
  | {
      url: string;
      /** Static headers (API keys etc). */
      headers?: Record<string, string>;
      /** true = OAuth with defaults, or pass options. Omit for no OAuth. */
      oauth?: boolean | OAuthOptions;
    }
  | { command: string; args?: string[]; env?: Record<string, string> };

// ---------------------------------------------------------------------------
// Token / client-info store (one file, keyed by server name)
// ---------------------------------------------------------------------------
const STORE_FILE = process.env.MCP_AUTH_STORE ?? ".mcp-auth.json";

type Entry = { client?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens };
type Store = Record<string, Entry>;

function readStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as Store;
  } catch {
    return {};
  }
}

function updateEntry(name: string, fn: (e: Entry) => void) {
  const store = readStore();
  const entry = store[name] ?? {};
  fn(entry);
  store[name] = entry;
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------
export class McpOAuthProvider implements OAuthClientProvider {
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;
  private currentState = randomUUID();
  private pendingCode?: string;
  private readonly port: number;
  private readonly redirect: string;

  constructor(
    readonly name: string,
    private readonly opts: OAuthOptions = {},
  ) {
    this.port = opts.port ?? 8765;
    this.redirect = `http://127.0.0.1:${this.port}/`;
  }

  get redirectUrl() {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "MCP Agent",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.opts.clientSecret ? "client_secret_post" : "none",
      scope: this.opts.scope,
    };
  }

  // Registered earlier (dynamic registration) or supplied by you (static).
  // Returning undefined tells the SDK to register a new client dynamically.
  clientInformation(): StoredOAuthClientInformation | undefined {
    const saved = readStore()[this.name]?.client;
    if (saved) return saved;
    if (this.opts.clientId) {
      return { client_id: this.opts.clientId, client_secret: this.opts.clientSecret };
    }
    return undefined;
  }

  saveClientInformation(info: StoredOAuthClientInformation) {
    updateEntry(this.name, (e) => (e.client = info));
  }

  tokens(): StoredOAuthTokens | undefined {
    return readStore()[this.name]?.tokens;
  }

  saveTokens(tokens: StoredOAuthTokens) {
    updateEntry(this.name, (e) => (e.tokens = tokens));
  }

  state() {
    this.currentState = randomUUID();
    return this.currentState;
  }

  saveCodeVerifier(v: string) {
    this.verifier = v;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("No PKCE code_verifier saved");
    return this.verifier;
  }

  // Lets the SDK check the callback came from the same authorization server
  // it discovered before the redirect (SEP-2352). Same lifetime as the verifier.
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    updateEntry(this.name, (e) => {
      if (scope === "all" || scope === "tokens") delete e.tokens;
      if (scope === "all" || scope === "client") delete e.client;
    });
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
  }

  // Opens the browser and WAITS for the redirect to our loopback listener.
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const code = await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", this.redirect);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (!code && !error) {
          res.writeHead(404).end(); // favicon etc.
          return;
        }
        if (url.searchParams.get("state") !== this.currentState) {
          res.writeHead(400).end("Invalid state");
          finish(new Error("OAuth state mismatch"));
          return;
        }
        if (error) {
          res.writeHead(400).end(`Authorization failed: ${error}`);
          finish(new Error(`Authorization server returned error: ${error}`));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Authorized. You can close this tab.");
        finish(undefined, code!);
      });

      const timer = setTimeout(
        () => finish(new Error("Timed out waiting for consent (5 min)")),
        5 * 60 * 1000,
      );

      function finish(err?: Error, value?: string) {
        clearTimeout(timer);
        server.close();
        server.closeAllConnections();
        if (err) reject(err);
        else resolve(value!);
      }

      server.on("error", reject); // e.g. EADDRINUSE
      server.listen(this.port, "127.0.0.1", () => {
        console.log(`[${this.name}] Opening browser to authorize...`);
        console.log(`[${this.name}] If it doesn't open, paste:\n${authorizationUrl}\n`);
        open(authorizationUrl.toString()).catch(() => {});
      });
    });
    this.pendingCode = code;
  }

  takePendingCode(): string | undefined {
    const c = this.pendingCode;
    this.pendingCode = undefined;
    return c;
  }
}

// ---------------------------------------------------------------------------
// Step 1 of the flow: probe the server without credentials
// ---------------------------------------------------------------------------
async function probe(serverUrl: string) {
  const res = await fetch(serverUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-oauth-probe", version: "1.0.0" },
      },
    }),
  });
  // Don't leave the body hanging (SSE responses).
  void res.body?.cancel().catch(() => {});
  return {
    status: res.status,
    ...(res.status === 401 ? extractWWWAuthenticateParams(res) : {}),
  };
}

// ---------------------------------------------------------------------------
// Steps 2-6: run the whole flow once for a server, unless a token is cached
// ---------------------------------------------------------------------------
export async function ensureAuthorized(provider: McpOAuthProvider, serverUrl: string) {
  if (provider.tokens()) {
    console.log(`[${provider.name}] using cached token`);
    return;
  }

  const p = await probe(serverUrl);
  if (p.status !== 401) {
    console.log(`[${provider.name}] server did not ask for auth (HTTP ${p.status}), skipping OAuth`);
    return;
  }

  const options = {
    serverUrl,
    resourceMetadataUrl: "resourceMetadataUrl" in p ? p.resourceMetadataUrl : undefined,
  };

  // discovery -> (dynamic registration) -> PKCE -> browser -> code captured
  const first = await auth(provider, options);
  if (first === "AUTHORIZED") return;

  const code = provider.takePendingCode();
  if (!code) throw new Error(`[${provider.name}] no authorization code captured`);

  // exchange code + verifier (+ secret) for a token, saved via saveTokens()
  const second = await auth(provider, { ...options, authorizationCode: code });
  if (second !== "AUTHORIZED") throw new Error(`[${provider.name}] token exchange failed`);
  console.log(`[${provider.name}] authorized`);
}

// ---------------------------------------------------------------------------
// Turn a map of server specs into ready-to-use MultiServerMCPClient connections
// ---------------------------------------------------------------------------
export async function prepareConnections(
  specs: Record<string, McpServerSpec>,
  opts: { reauth?: string[] } = {},
): Promise<Record<string, Connection>> {
  const out: Record<string, Connection> = {};

  for (const [name, spec] of Object.entries(specs)) {
    if ("command" in spec) {
      out[name] = {
        transport: "stdio",
        command: spec.command,
        args: spec.args ?? [],
        env: spec.env,
      };
      continue;
    }

    if (!spec.oauth) {
      out[name] = { transport: "http", url: spec.url, headers: spec.headers };
      continue;
    }

    const oauthOpts = spec.oauth === true ? {} : spec.oauth;
    const provider = new McpOAuthProvider(name, oauthOpts);
    if (opts.reauth?.includes(name)) provider.invalidateCredentials("tokens");

    await ensureAuthorized(provider, spec.url); // sequential: one browser at a time
    out[name] = {
      transport: "http",
      url: spec.url,
      headers: spec.headers,
      authProvider: provider,
    };
  }
  return out;
}