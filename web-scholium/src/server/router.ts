// The only way into the backend. Every request is authorised here before any route is matched and before
// any Durable Object is addressed. Written against structural types so the tests drive the very same code.
import { ALLOWED_EMAIL, asciiLower, emailAllowed, internalKey, ownerHashFor, routeAccess, signDriveState, signTicket, verifyDriveState, verifyTicket, WS_TICKET_TTL_MS } from "../shared/gate";
import { OLD_SITES, oldSitePass } from "../shared/oldSite";
import type { Verified } from "./verify";

export interface StubLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
export interface NamespaceLike {
  getByName(name: string): StubLike;
}
export interface RouterEnv {
  RUN: NamespaceLike;
  WORKSPACE: NamespaceLike;
  SCHOLIUM_SECRET?: string;
}
export interface RouterDeps {
  verify(token: string): Promise<Verified>;
  now(): number;
  /** Lower-case letters and digits, at least 20 characters. */
  randomId(): string;
}
export interface Identity {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  exp: number;
  ownerHash: string;
}

export const JSON_LIMIT = 1_000_000;
export const UPLOAD_LIMIT = 16_000_000;
export const BACKUP_LIMIT = 40_000_000;
const INTERNAL = "https://scholium.internal";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response => json({ error, message, ...extra }, status);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Adds the headers every API answer carries. Upgrade responses pass through untouched. */
function finish(res: Response): Response {
  if (res.status === 101) return res;
  const h = new Headers(res.headers);
  h.set("cache-control", "no-store");
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "no-referrer");
  h.set("x-frame-options", "DENY");
  h.delete("access-control-allow-origin");
  const type = h.get("content-type") ?? "";
  if (!type.startsWith("application/json") && !type.startsWith("text/html")) {
    if (!h.has("content-disposition")) h.set("content-disposition", "attachment");
    h.set("content-security-policy", "default-src 'none'; sandbox");
  }
  return new Response(res.body, { status: res.status, headers: h });
}

export type AuthResult = { ok: true; id: Identity } | { ok: false; res: Response };

/** Verifies the bearer token and checks it belongs to the one allowed account. */
export async function authorize(req: Request, deps: RouterDeps): Promise<AuthResult> {
  const m = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return { ok: false, res: fail(401, "signed_out", "Sign in to continue.") };
  const v = await deps.verify(m[1]);
  if (!v.ok) return { ok: false, res: fail(401, "invalid_token", "This session is not valid. Sign in again.", { reason: v.reason }) };
  // The platform also verifies the token and stamps who it belongs to. If present, both must agree.
  const hid = req.headers.get("x-rork-user-id");
  const hem = req.headers.get("x-rork-user-email");
  if ((hid !== null && hid !== v.sub) || (hem !== null && asciiLower(hem) !== asciiLower(v.email))) {
    return { ok: false, res: fail(401, "invalid_token", "This session is not valid. Sign in again.", { reason: "identity_mismatch" }) };
  }
  if (v.emailVerified === false || (v.provider !== undefined && v.provider !== "google") || !emailAllowed(v.email)) {
    return { ok: false, res: fail(403, "not_allowed", "This workspace is private. This account does not have access.") };
  }
  return { ok: true, id: { sub: v.sub, email: v.email, name: v.name, picture: v.picture, exp: v.exp, ownerHash: await ownerHashFor(v.email) } };
}

interface Ctx {
  req: Request;
  url: URL;
  env: RouterEnv;
  deps: RouterDeps;
  id: Identity;
  key: string;
}
type Handler = (c: Ctx, m: RegExpExecArray) => Promise<Response>;

const runStub = (c: Ctx, runId: string): StubLike => c.env.RUN.getByName(`run:${runId}`);
const wsStub = (c: Ctx): StubLike => c.env.WORKSPACE.getByName(`ws:${c.id.ownerHash}`);

function call(stub: StubLike, c: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "x-scholium-key": c.key, "x-scholium-owner": c.id.ownerHash };
  if (body === undefined) return stub.fetch(`${INTERNAL}${path}`, { method, headers });
  headers["content-type"] = "application/json";
  return stub.fetch(`${INTERNAL}${path}`, { method, headers, body: JSON.stringify(body) });
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  const tooLarge = { ok: false as const, res: fail(413, "too_large", "This request is larger than the server accepts.") };
  if (Number(req.headers.get("content-length") ?? "0") > JSON_LIMIT) return tooLarge;
  const text = await req.text();
  if (text.length > JSON_LIMIT) return tooLarge;
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, res: fail(400, "bad_json", "The request body is not valid JSON.") };
  }
}

const withJson = (fn: (c: Ctx, body: unknown, m: RegExpExecArray) => Promise<Response>): Handler => async (c, m) => {
  const b = await readJson(c.req);
  return b.ok ? fn(c, b.value, m) : b.res;
};

const R = "/api/runs/([a-z0-9]{16,40})";
const S = "([A-Za-z0-9_-]{1,64})";
const re = (p: string): RegExp => new RegExp(`^${p}$`);
const toRun = (path: string, method = "GET"): Handler => (c, m) => call(runStub(c, m[1]), c, method, path + c.url.search);
const jsonToRun = (path: string, method: string): Handler => withJson((c, b, m) => call(runStub(c, m[1]), c, method, path, b));
const toWs = (path: string): Handler => (c) => call(wsStub(c), c, "GET", path);
const jsonToWs = (path: string, method: string): Handler => withJson((c, b) => call(wsStub(c), c, method, path, b));

/** The complete list of routes. Anything not listed here does not exist. */
const ROUTES: [string, RegExp, Handler][] = [
  ["GET", re("/api/me"), async (c) => json({ email: c.id.email, name: c.id.name ?? null, picture: c.id.picture ?? null, expiresAt: c.id.exp * 1000 })],
  ["GET", re("/api/workspace"), (c) => call(wsStub(c), c, "GET", `/internal/overview?origin=${encodeURIComponent(c.url.origin)}`)],
  ["PUT", re("/api/workspace/settings"), jsonToWs("/internal/settings", "PUT")],
  ["POST", re("/api/workspace/diagnostics"), jsonToWs("/internal/diagnostics", "POST")],
  ["POST", re("/api/workspace/test-email"), jsonToWs("/internal/test-email", "POST")],
  ["POST", re("/api/vault/takeover"), jsonToWs("/internal/vault/takeover", "POST")],
  ["POST", re("/api/vault/move-key"), jsonToWs("/internal/vault/move-key", "POST")],
  ["GET", re("/api/vault/info"), toWs("/internal/vault/info")],
  ["GET", re("/api/vault/check"), toWs("/internal/vault/check")],
  ["GET", re("/api/vault/code"), toWs("/internal/vault/code")],
  ["GET", re(`${R}/vault-check`), toRun("/internal/vault/check")],
  ["GET", re("/api/workspace/strategy"), toWs("/internal/strategy")],
  ["POST", re("/api/workspace/strategy/(propose|evaluate|adopt|reject|rollback)"), withJson((c, b, m) => call(wsStub(c), c, "POST", `/internal/strategy/${m[1]}`, b))],
  [
    "POST",
    re("/api/runs"),
    withJson((c, b) => {
      const id = c.deps.randomId();
      return call(runStub(c, id), c, "POST", "/internal/init", { id, config: rec(b).config, origin: c.url.origin });
    }),
  ],
  [
    "POST",
    re("/api/import/list"),
    withJson(async (c, b) => {
      const token = oldSitePass(rec(b).token);
      if (!token) return fail(400, "bad_request", "Paste the pass copied from the old site.");
      const runs: Record<string, unknown>[] = [];
      let reached = 0;
      let refused = 0;
      for (const [site, base] of OLD_SITES.entries()) {
        try {
          const res = await fetch(`${base}/api/workspace`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
          if (res.status === 401 || res.status === 403) refused++;
          if (!res.ok) continue;
          reached++;
          const list = rec(await res.json()).runs;
          for (const r of Array.isArray(list) ? list.slice(0, 500) : []) runs.push({ ...rec(r), site });
        } catch {
          // An old address that does not answer is skipped; the other one may still hold the runs.
        }
      }
      if (!reached) return refused ? fail(409, "refused", "The old site did not accept that pass. It lasts about an hour: copy a new one and try again.") : fail(502, "unreachable", "The old site could not be reached. Try again in a moment.");
      return json({ runs });
    }),
  ],
  [
    "POST",
    re("/api/import/run"),
    withJson((c, b) => {
      const token = oldSitePass(rec(b).token);
      const base = OLD_SITES[Number(rec(b).site)];
      const runId = String(rec(b).runId ?? "");
      if (!token || !base || !/^[a-z0-9]{16,40}$/.test(runId)) return Promise.resolve(fail(400, "bad_request", "Choose a run to bring over."));
      const id = c.deps.randomId();
      return call(runStub(c, id), c, "POST", "/internal/init", { id, origin: c.url.origin, remote: { base, token, runId } });
    }),
  ],
  [
    "POST",
    re("/api/import/file"),
    async (c) => {
      const tooLarge = fail(413, "too_large", "This backup file is larger than the 40 MB the workspace accepts.");
      if (Number(c.req.headers.get("content-length") ?? "0") > BACKUP_LIMIT) return tooLarge;
      const buf = await c.req.arrayBuffer();
      if (buf.byteLength > BACKUP_LIMIT) return tooLarge;
      let a: Record<string, unknown>;
      try {
        a = rec(JSON.parse(new TextDecoder().decode(buf)));
      } catch {
        a = {};
      }
      if (a.scholiumBackup !== 1 || !rec(a.checkpoint).config) return fail(400, "bad_backup", "This file is not a Scholium backup, or it is damaged.");
      const id = c.deps.randomId();
      return call(runStub(c, id), c, "POST", "/internal/init", { id, origin: c.url.origin, archive: { checkpoint: a.checkpoint, texts: a.texts, files: a.files } });
    },
  ],
  ["GET", re(`${R}/backup`), toRun("/internal/backup")],
  [
    "POST",
    re(`${R}/branch`),
    withJson((c, b, m) => {
      const id = c.deps.randomId();
      const checkpointId = String(rec(b).checkpointId ?? "");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(checkpointId)) return Promise.resolve(fail(400, "bad_request", "Choose a checkpoint to branch from."));
      return call(runStub(c, id), c, "POST", "/internal/init", { id, config: rec(b).config, origin: c.url.origin, branchedFrom: { runId: m[1], checkpointId } });
    }),
  ],
  ["GET", re(R), toRun("/internal/snapshot")],
  [
    "DELETE",
    re(R),
    async (c, m) => {
      const gone = await call(runStub(c, m[1]), c, "POST", "/internal/destroy");
      if (!gone.ok) return gone;
      return call(wsStub(c), c, "DELETE", `/internal/runs/${m[1]}`);
    },
  ],
  ["POST", re(`${R}/action`), jsonToRun("/internal/action", "POST")],
  ["PUT", re(`${R}/config`), jsonToRun("/internal/config", "PUT")],
  ["POST", re(`${R}/instructions`), jsonToRun("/internal/instructions", "POST")],
  ["POST", re(`${R}/instructions/reorder`), jsonToRun("/internal/instructions/reorder", "POST")],
  ["PUT", re(`${R}/instructions/${S}`), withJson((c, b, m) => call(runStub(c, m[1]), c, "PUT", `/internal/instructions/${m[2]}`, b))],
  ["DELETE", re(`${R}/instructions/${S}`), (c, m) => call(runStub(c, m[1]), c, "DELETE", `/internal/instructions/${m[2]}`)],
  [
    "POST",
    re(`${R}/uploads`),
    async (c, m) => {
      const tooLarge = fail(413, "too_large", "This file is larger than the 12 MB the workspace accepts.");
      if (Number(c.req.headers.get("content-length") ?? "0") > UPLOAD_LIMIT) return tooLarge;
      const buf = await c.req.arrayBuffer();
      if (buf.byteLength > UPLOAD_LIMIT) return tooLarge;
      const headers = { "x-scholium-key": c.key, "x-scholium-owner": c.id.ownerHash, "content-type": c.req.headers.get("content-type") ?? "application/octet-stream" };
      return runStub(c, m[1]).fetch(`${INTERNAL}/internal/uploads`, { method: "POST", headers, body: buf });
    },
  ],
  ["GET", re(`${R}/uploads/${S}/file`), (c, m) => call(runStub(c, m[1]), c, "GET", `/internal/uploads/${m[2]}/file`)],
  ["GET", re(`${R}/tasks/${S}/messages`), (c, m) => call(runStub(c, m[1]), c, "GET", `/internal/tasks/${m[2]}/messages`)],
  ["GET", re(`${R}/checkpoints/${S}`), (c, m) => call(runStub(c, m[1]), c, "GET", `/internal/checkpoints/${m[2]}`)],
  ["GET", re(`${R}/calls`), toRun("/internal/calls")],
  ["GET", re(`${R}/text`), toRun("/internal/text")],
  ["GET", re(`${R}/search`), toRun("/internal/search")],
  ["GET", re(`${R}/export`), toRun("/internal/export")],
  ["GET", re(`${R}/entity`), toRun("/internal/entity")],
  [
    "POST",
    re(`${R}/ws-ticket`),
    async (c, m) => {
      const owned = await call(runStub(c, m[1]), c, "GET", "/internal/exists");
      if (!owned.ok) return owned;
      const ticket = await signTicket(c.env.SCHOLIUM_SECRET ?? "", m[1], c.id.ownerHash, c.deps.randomId(), c.deps.now());
      return json({ ticket, expiresInMs: WS_TICKET_TTL_MS });
    },
  ],
  [
    "POST",
    re("/api/drive/start"),
    async (c) => {
      const nonce = c.deps.randomId();
      const state = await signDriveState(c.env.SCHOLIUM_SECRET ?? "", nonce, c.deps.now());
      return call(wsStub(c), c, "POST", "/internal/drive/start", { nonce, state, redirectUri: `${c.url.origin}/api/drive/callback` });
    },
  ],
  ["POST", re("/api/drive/disconnect"), (c) => call(wsStub(c), c, "POST", "/internal/drive/disconnect")],
];

function page(title: string, message: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.5 Georgia,serif;background:#f6f1e7;color:#1d1a16;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:30rem;padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:0}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } });
}

async function route(req: Request, url: URL, env: RouterEnv, deps: RouterDeps): Promise<Response> {
  const path = url.pathname;
  const access = routeAccess(req.method, path);
  if (access === "public" && path === "/api/health") return json({ ok: true });
  const secret = env.SCHOLIUM_SECRET ?? "";
  if (secret.length < 16) return fail(503, "not_configured", "The server is not configured yet.");
  const key = await internalKey(secret);

  if (access === "public") {
    // Google's redirect. The state must be one this server signed; the workspace then checks it was issued and unused.
    const st = await verifyDriveState(secret, url.searchParams.get("state") ?? "", deps.now());
    if (!st.ok) {
      // Only a state this server signed is told that it lapsed; anything else gets no detail.
      console.log("drive callback refused at the door:", st.reason);
      const why = st.reason === "expired" ? "More than ten minutes passed between pressing Connect and approving, so this attempt lapsed." : "This link was not issued by this workspace.";
      return page("Google Drive was not connected", `${why} Nothing was changed. Start again from Settings in Scholium.`, 400);
    }
    const ownerHash = await ownerHashFor(ALLOWED_EMAIL);
    const res = await env.WORKSPACE.getByName(`ws:${ownerHash}`).fetch(`${INTERNAL}/internal/drive/callback`, {
      method: "POST",
      headers: { "x-scholium-key": key, "x-scholium-owner": ownerHash, "content-type": "application/json" },
      body: JSON.stringify({ nonce: st.nonce, code: (url.searchParams.get("code") ?? "").slice(0, 2000), error: (url.searchParams.get("error") ?? "").slice(0, 200) }),
    });
    const out = rec(await res.json().catch(() => ({})));
    const ok = res.ok && out.ok === true;
    return page(ok ? "Google Drive is connected" : "Google Drive was not connected", typeof out.message === "string" ? out.message : "Return to Scholium and try again.", ok ? 200 : 400);
  }

  if (access === "ticket") {
    if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return fail(426, "upgrade_required", "This address only accepts a live connection.");
    const runId = path.split("/")[3];
    const t = await verifyTicket(secret, url.searchParams.get("ticket") ?? "", runId, deps.now());
    if (!t.ok) return fail(401, "invalid_ticket", "This live connection was not authorised. Request a new ticket.");
    return env.RUN.getByName(`run:${runId}`).fetch(`${INTERNAL}/internal/ws`, {
      headers: { upgrade: "websocket", "x-scholium-key": key, "x-scholium-owner": t.ownerHash, "x-scholium-nonce": t.nonce },
    });
  }

  const auth = await authorize(req, deps);
  if (!auth.ok) return auth.res;
  const c: Ctx = { req, url, env, deps, id: auth.id, key };
  for (const [method, pattern, handler] of ROUTES) {
    if (method !== req.method) continue;
    const m = pattern.exec(path);
    if (m) return handler(c, m);
  }
  return fail(404, "not_found", "There is nothing at this address.");
}

/** Handles everything under /api/. Returns null for any other path, which the caller serves as a static file. */
export async function handle(req: Request, env: RouterEnv, deps: RouterDeps): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path.startsWith("/internal")) return finish(fail(404, "not_found", "There is nothing at this address."));
  if (path !== "/api" && !path.startsWith("/api/")) return null;
  try {
    return finish(await route(req, url, env, deps));
  } catch (e) {
    console.error("request failed:", req.method, path, e instanceof Error ? e.message.slice(0, 300) : "unknown error");
    return finish(fail(500, "server_error", "The server could not complete this request."));
  }
}
