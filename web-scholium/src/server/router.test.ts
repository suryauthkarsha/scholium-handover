import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { ALLOWED_EMAIL, internalKey, ownerHashFor, signDriveState, signTicket, TOKEN_AUDIENCE, TOKEN_ISSUER } from "../shared/gate";
import { handle, type NamespaceLike, type RouterDeps, type RouterEnv } from "./router";
import { makeVerifier } from "./verify";

const SECRET = "router-test-secret-0123456789abcdef";
const ID = "abcdefgh12345678abcd";
const OTHER_RUN = "zzzzzzzz12345678zzzz";
const BASE = "https://scholium.test";
const NOW = () => Date.now();

interface Call {
  ns: string;
  name: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let privateKey: CryptoKey;
let strangerKey: CryptoKey;
let publicJwk: JWK;
let deps: RouterDeps;
let counter = 0;

beforeAll(async () => {
  const a = await generateKeyPair("RS256");
  const b = await generateKeyPair("RS256");
  privateKey = a.privateKey;
  strangerKey = b.privateKey;
  publicJwk = { ...(await exportJWK(a.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  deps = { verify: makeVerifier({ key: createLocalJWKSet({ keys: [publicJwk] }) }), now: NOW, randomId: () => `id${String(++counter).padStart(18, "0")}` };
});

function world(secret: string | undefined = SECRET) {
  const calls: Call[] = [];
  const ns = (label: string): NamespaceLike => ({
    getByName: (name) => ({
      fetch: async (input, init) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
        calls.push({ ns: label, name, path: input.replace("https://scholium.internal", ""), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : undefined });
        return new Response(JSON.stringify({ ok: true, message: "done" }), { headers: { "content-type": "application/json" } });
      },
    }),
  });
  const env: RouterEnv = { RUN: ns("run"), WORKSPACE: ns("ws"), SCHOLIUM_SECRET: secret };
  return { env, calls };
}

interface TokenOpts {
  email?: string;
  sub?: string;
  iss?: string;
  aud?: string;
  exp?: number;
  key?: CryptoKey;
  extra?: Record<string, unknown>;
}
function token(o: TokenOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: o.email ?? ALLOWED_EMAIL, name: "Test User", ...o.extra })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(o.iss ?? TOKEN_ISSUER)
    .setAudience(o.aud ?? TOKEN_AUDIENCE)
    .setSubject(o.sub ?? "user-1")
    .setIssuedAt(now - 10)
    .setExpirationTime(o.exp ?? now + 3600)
    .sign(o.key ?? privateKey);
}

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

async function send(env: RouterEnv, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Response> {
  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== "GET") init.body = body;
  else if (method !== "GET" && method !== "DELETE") init.body = "{}";
  const res = await handle(new Request(`${BASE}${path}`, init), env, deps);
  if (!res) throw new Error(`no response for ${path}`);
  return res;
}

const ROUTES: [string, string][] = [
  ["GET", "/api/me"],
  ["GET", "/api/workspace"],
  ["PUT", "/api/workspace/settings"],
  ["POST", "/api/workspace/diagnostics"],
  ["POST", "/api/workspace/test-email"],
  ["GET", "/api/workspace/strategy"],
  ["POST", "/api/workspace/strategy/adopt"],
  ["POST", "/api/runs"],
  ["GET", `/api/runs/${ID}`],
  ["DELETE", `/api/runs/${ID}`],
  ["POST", `/api/runs/${ID}/action`],
  ["PUT", `/api/runs/${ID}/config`],
  ["POST", `/api/runs/${ID}/instructions`],
  ["POST", `/api/runs/${ID}/instructions/reorder`],
  ["PUT", `/api/runs/${ID}/instructions/I1`],
  ["DELETE", `/api/runs/${ID}/instructions/I1`],
  ["POST", `/api/runs/${ID}/uploads`],
  ["GET", `/api/runs/${ID}/uploads/U1/file`],
  ["GET", `/api/runs/${ID}/tasks/T1/messages`],
  ["GET", `/api/runs/${ID}/checkpoints/K1`],
  ["GET", `/api/runs/${ID}/calls`],
  ["GET", `/api/runs/${ID}/text?ref=src%3AS1`],
  ["GET", `/api/runs/${ID}/search?q=zeta`],
  ["GET", `/api/runs/${ID}/export?format=md`],
  ["GET", `/api/runs/${ID}/entity?kind=claim&id=C1`],
  ["POST", `/api/runs/${ID}/branch`],
  ["POST", `/api/runs/${ID}/ws-ticket`],
  ["POST", "/api/drive/start"],
  ["POST", "/api/drive/disconnect"],
  ["GET", "/api/unknown"],
  ["GET", "/api/internal/snapshot"],
  ["GET", "/api"],
  ["OPTIONS", "/api/workspace"],
];

describe("signed-out requests", () => {
  it("get 401 on every route, and no backend object is ever addressed", async () => {
    const { env, calls } = world();
    for (const [m, p] of ROUTES) {
      const res = await send(env, m, p);
      expect(res.status, `${m} ${p}`).toBe(401);
      expect((await res.json()).error).toBe("signed_out");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it("cannot get in with identity headers they wrote themselves", async () => {
    const { env, calls } = world();
    const forged = { "x-rork-user-email": ALLOWED_EMAIL, "x-rork-user-id": "user-1", "x-scholium-owner": await ownerHashFor(ALLOWED_EMAIL), "x-scholium-key": await internalKey(SECRET) };
    for (const [m, p] of ROUTES) expect((await send(env, m, p, forged)).status, `${m} ${p}`).toBe(401);
    expect((await send(env, "GET", "/api/workspace", { ...forged, cookie: "rork:access_token=x; session=x" })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("only see a health check that says nothing", async () => {
    const { env, calls } = world();
    const res = await send(env, "GET", "/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([]);
  });
});

describe("invalid sessions", () => {
  it("are refused whatever is wrong with the token", async () => {
    const good = await token();
    const [h, p, s] = good.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    const bad: Record<string, string> = {
      garbage: "not.a.token",
      empty: "",
      expired: await token({ exp: Math.floor(Date.now() / 1000) - 120 }),
      "wrong audience": await token({ aud: "another-project" }),
      "wrong issuer": await token({ iss: "https://evil.example" }),
      "signed by another key": await token({ key: strangerKey }),
      "tampered payload": `${h}.${b64({ ...payload, sub: "user-2" })}.${s}`,
      "alg none": `${b64({ alg: "none", typ: "JWT" })}.${p}.`,
      "HS256 with the public key": await new SignJWT({ email: ALLOWED_EMAIL }).setProtectedHeader({ alg: "HS256" }).setIssuer(TOKEN_ISSUER).setAudience(TOKEN_AUDIENCE).setSubject("user-1").setExpirationTime("1h").sign(new TextEncoder().encode(JSON.stringify(publicJwk))),
      "no email": await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(TOKEN_ISSUER).setAudience(TOKEN_AUDIENCE).setSubject("user-1").setExpirationTime("1h").sign(privateKey),
      "no expiry": await new SignJWT({ email: ALLOWED_EMAIL }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(TOKEN_ISSUER).setAudience(TOKEN_AUDIENCE).setSubject("user-1").sign(privateKey),
    };
    const { env, calls } = world();
    for (const [name, t] of Object.entries(bad)) {
      for (const [m, path] of [ROUTES[1], ROUTES[8], ROUTES[17], ROUTES[26]]) {
        const res = await send(env, m, path, { authorization: `Bearer ${t}` });
        expect(res.status, `${name}: ${m} ${path}`).toBe(401);
      }
    }
    expect(calls).toEqual([]);
  });

  it("are refused when the platform's verified identity disagrees with the token", async () => {
    const { env, calls } = world();
    const stranger = await token({ email: "someone.else@gmail.com", sub: "user-9" });
    const res = await send(env, "GET", "/api/workspace", { authorization: `Bearer ${stranger}`, "x-rork-user-email": ALLOWED_EMAIL });
    expect(res.status).toBe(401);
    const mine = await token();
    expect((await send(env, "GET", "/api/workspace", { authorization: `Bearer ${mine}`, "x-rork-user-id": "user-2" })).status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe("other accounts", () => {
  it("are refused on every route with a valid token, without learning which account is allowed", async () => {
    const others: TokenOpts[] = [
      { email: "someone.else@gmail.com" },
      { email: ALLOWED_EMAIL.replace("@", "+x@") },
      { email: ALLOWED_EMAIL.replace("a", "\u0430") },
      { email: ALLOWED_EMAIL.replace("gmail.com", "googlemail.com") },
      { email: `${ALLOWED_EMAIL}.example.org` },
      { extra: { email_verified: false } },
      { extra: { provider: "apple" } },
    ];
    const { env, calls } = world();
    for (const o of others) {
      const t = await token(o);
      for (const [m, p] of ROUTES) {
        const res = await send(env, m, p, { authorization: `Bearer ${t}` });
        expect(res.status, `${JSON.stringify(o)}: ${m} ${p}`).toBe(403);
        const text = await res.text();
        expect(JSON.parse(text).error).toBe("not_allowed");
        expect(text).not.toContain(ALLOWED_EMAIL);
      }
    }
    expect(calls).toEqual([]);
  });
});

describe("the allowed account", () => {
  it("reaches each route's backend object, which receives the internal key and the owner", async () => {
    const t = await token();
    const key = await internalKey(SECRET);
    const owner = await ownerHashFor(ALLOWED_EMAIL);
    const auth = { authorization: `Bearer ${t}`, "x-rork-user-email": ALLOWED_EMAIL.toUpperCase(), "x-rork-user-id": "user-1" };
    for (const [m, p] of ROUTES) {
      const { env, calls } = world();
      const res = await send(env, m, p, auth);
      if (p === "/api/me") {
        expect((await res.json()).email).toBe(ALLOWED_EMAIL);
        expect(calls).toEqual([]);
        continue;
      }
      if (p === "/api/unknown" || p === "/api/internal/snapshot" || p === "/api" || m === "OPTIONS") {
        expect(res.status, `${m} ${p}`).toBe(404);
        expect(calls).toEqual([]);
        continue;
      }
      if (p.endsWith("/branch")) {
        expect(res.status).toBe(400);
        continue;
      }
      expect(res.status, `${m} ${p}`).toBe(200);
      expect(calls.length, `${m} ${p}`).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.headers["x-scholium-key"]).toBe(key);
        expect(c.headers["x-scholium-owner"]).toBe(owner);
        expect(c.path.startsWith("/internal/")).toBe(true);
        expect(c.name).toBe(c.ns === "ws" ? `ws:${owner}` : c.path.startsWith("/internal/init") ? c.name : `run:${ID}`);
      }
    }
  });

  it("creates, branches and deletes runs through the right objects", async () => {
    const auth = { authorization: `Bearer ${await token()}` };
    const { env, calls } = world();
    await send(env, "POST", "/api/runs", auth, JSON.stringify({ config: { goal: "g" } }));
    expect(calls[0].path).toBe("/internal/init");
    expect(calls[0].name).toMatch(/^run:id\d{18}$/);
    expect(JSON.parse(calls[0].body ?? "{}").origin).toBe(BASE);
    await send(env, "POST", `/api/runs/${ID}/branch`, auth, JSON.stringify({ checkpointId: "K1" }));
    expect(JSON.parse(calls[1].body ?? "{}").branchedFrom).toEqual({ runId: ID, checkpointId: "K1" });
    await send(env, "DELETE", `/api/runs/${ID}`, auth);
    expect(calls.slice(2).map((c) => `${c.ns} ${c.method} ${c.path}`)).toEqual(["run POST /internal/destroy", `ws DELETE /internal/runs/${ID}`]);
  });

  it("has request size and format limits", async () => {
    const auth = { authorization: `Bearer ${await token()}` };
    const { env, calls } = world();
    expect((await send(env, "PUT", "/api/workspace/settings", auth, "{not json")).status).toBe(400);
    expect((await send(env, "PUT", "/api/workspace/settings", auth, JSON.stringify({ pad: "x".repeat(1_000_100) }))).status).toBe(413);
    expect((await send(env, "POST", `/api/runs/${ID}/uploads`, auth, "x".repeat(16_000_100))).status).toBe(413);
    expect(calls).toEqual([]);
  });
});

describe("the live stream", () => {
  const upgrade = { upgrade: "websocket" };
  it("needs a ticket minted for a verified session and bound to that run", async () => {
    const { env, calls } = world();
    const owner = await ownerHashFor(ALLOWED_EMAIL);
    expect((await send(env, "GET", `/api/runs/${ID}/ws`, upgrade)).status).toBe(401);
    expect((await send(env, "GET", `/api/runs/${ID}/ws?ticket=abc.def.1.2.3`, upgrade)).status).toBe(401);
    const expired = await signTicket(SECRET, ID, owner, "n0", Date.now() - 60_000);
    expect((await send(env, "GET", `/api/runs/${ID}/ws?ticket=${expired}`, upgrade)).status).toBe(401);
    const elsewhere = await signTicket(SECRET, OTHER_RUN, owner, "n1", Date.now());
    expect((await send(env, "GET", `/api/runs/${ID}/ws?ticket=${elsewhere}`, upgrade)).status).toBe(401);
    const forged = await signTicket("some-other-secret-0123456789", ID, owner, "n2", Date.now());
    expect((await send(env, "GET", `/api/runs/${ID}/ws?ticket=${forged}`, upgrade)).status).toBe(401);
    expect((await send(env, "GET", `/api/runs/${ID}/ws?ticket=${expired}`, { ...upgrade, authorization: `Bearer ${await token({ email: "x@gmail.com" })}` })).status).toBe(401);
    expect(calls).toEqual([]);

    const good = await signTicket(SECRET, ID, owner, "n3", Date.now());
    expect((await send(env, "GET", `/api/runs/${ID}/ws?ticket=${good}`)).status).toBe(426);
    expect(calls).toEqual([]);
    await send(env, "GET", `/api/runs/${ID}/ws?ticket=${good}`, upgrade);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ns: "run", name: `run:${ID}`, path: "/internal/ws" });
    expect(calls[0].headers["x-scholium-nonce"]).toBe("n3");
    expect(calls[0].headers["x-scholium-owner"]).toBe(owner);
  });

  it("issues a ticket only after the run confirms it belongs to the caller", async () => {
    const { env, calls } = world();
    const res = await send(env, "POST", `/api/runs/${ID}/ws-ticket`, { authorization: `Bearer ${await token()}` });
    expect(typeof (await res.json()).ticket).toBe("string");
    expect(calls.map((c) => c.path)).toEqual(["/internal/exists"]);
  });
});

describe("the Google Drive redirect", () => {
  it("does nothing without a state this server signed", async () => {
    const { env, calls } = world();
    for (const q of ["", "?code=abc", "?code=abc&state=forged.1.2", `?code=abc&state=${await signDriveState("some-other-secret-0123456789", "n", Date.now())}`, `?code=abc&state=${await signDriveState(SECRET, "n", Date.now() - 3_600_000)}`]) {
      const res = await send(env, "GET", `/api/drive/callback${q}`);
      expect(res.status, q).toBe(400);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
    expect(calls).toEqual([]);
    const res = await send(env, "GET", `/api/drive/callback?code=abc&state=${await signDriveState(SECRET, "nonce9", Date.now())}`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ns: "ws", path: "/internal/drive/callback", method: "POST" });
    expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({ nonce: "nonce9", code: "abc" });
  });
});

describe("fail-closed behaviour", () => {
  it("serves nothing when the server secret is missing", async () => {
    const { env, calls } = world("");
    expect((await send(env, "GET", "/api/workspace", { authorization: `Bearer ${await token()}` })).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("never routes the internal paths from outside, and leaves other paths to static files", async () => {
    const { env, calls } = world();
    const res = await handle(new Request(`${BASE}/internal/snapshot`, { headers: { authorization: `Bearer ${await token()}` } }), env, deps);
    expect(res?.status).toBe(404);
    expect(await handle(new Request(`${BASE}/r/${ID}`), env, deps)).toBeNull();
    expect(calls).toEqual([]);
  });
});
