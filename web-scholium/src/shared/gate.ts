// The front door's fixed rules: who may enter, which routes are open, and the short-lived signed tokens
// used where a bearer token cannot travel (WebSocket upgrades, the Google redirect).
// Pure functions on Web Crypto only, so the Worker and the tests run exactly the same code.
// This file is part of the immutable policy layer: no model output and no workspace setting can change it.

/** The only account allowed into this workspace. */
export const ALLOWED_EMAIL = "suryauthkarsha1@gmail.com";
export const TOKEN_ISSUER = "https://api.rork.com";
export const TOKEN_AUDIENCE = "o4rqyalyak6lp2lo9xgdo";
export const JWKS_URL = "https://api.rork.com/.well-known/jwks.json";
export const RUN_ID = /^[a-z0-9]{16,40}$/;
export const WS_TICKET_TTL_MS = 30_000;
export const DRIVE_STATE_TTL_MS = 10 * 60_000;

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Lower-cases A-Z only. Unicode case folding is deliberately not used: it maps look-alike letters onto ASCII. */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** True only for the one allowed address: printable ASCII, compared without regard to letter case. */
export function emailAllowed(email: unknown, allowed: string = ALLOWED_EMAIL): boolean {
  if (typeof email !== "string" || email.length === 0 || email.length > 254) return false;
  if (!/^[\x21-\x7e]+$/.test(email)) return false;
  return timingSafeEqual(asciiLower(email), asciiLower(allowed));
}

export async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export const ownerHashFor = (email: string): Promise<string> => sha256(`scholium-owner:${asciiLower(email)}`);
/** Shared between the router and the Durable Objects, so an object answers only requests that came through the router. */
export const internalKey = (secret: string): Promise<string> => sha256(`scholium-internal:${secret}`);

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

const PART = /^[A-Za-z0-9_-]+$/;

/** Signs `parts` for one purpose until `exp` (milliseconds). */
export async function seal(secret: string, purpose: string, parts: string[], exp: number): Promise<string> {
  if (parts.some((p) => !PART.test(p))) throw new Error("A sealed token part has unsupported characters.");
  const body = [...parts, String(Math.floor(exp))].join(".");
  return `${body}.${await hmac(secret, `${purpose}|${body}`)}`;
}

export type Unsealed = { ok: true; parts: string[]; exp: number } | { ok: false; reason: string };

export async function unseal(secret: string, purpose: string, token: string, count: number, now: number): Promise<Unsealed> {
  if (typeof token !== "string" || token.length === 0 || token.length > 600) return { ok: false, reason: "malformed" };
  const seg = token.split(".");
  if (seg.length !== count + 2 || seg.some((s) => !PART.test(s))) return { ok: false, reason: "malformed" };
  const body = seg.slice(0, -1).join(".");
  if (!timingSafeEqual(seg[seg.length - 1], await hmac(secret, `${purpose}|${body}`))) return { ok: false, reason: "signature" };
  const exp = Number(seg[seg.length - 2]);
  if (!Number.isFinite(exp) || exp < now) return { ok: false, reason: "expired" };
  return { ok: true, parts: seg.slice(0, count), exp };
}

/** A single-use pass for one run's live socket, minted for a verified session and valid for half a minute. */
export const signTicket = (secret: string, runId: string, ownerHash: string, nonce: string, now: number): Promise<string> =>
  seal(secret, "ws-ticket", [runId, ownerHash, nonce], now + WS_TICKET_TTL_MS);

export async function verifyTicket(secret: string, ticket: string, runId: string, now: number): Promise<{ ok: true; ownerHash: string; nonce: string } | { ok: false; reason: string }> {
  const t = await unseal(secret, "ws-ticket", ticket, 3, now);
  if (!t.ok) return t;
  if (!timingSafeEqual(t.parts[0], runId)) return { ok: false, reason: "wrong_run" };
  return { ok: true, ownerHash: t.parts[1], nonce: t.parts[2] };
}

/** The `state` value sent to Google, so the public redirect can be checked before anything is looked up. */
export const signDriveState = (secret: string, nonce: string, now: number): Promise<string> => seal(secret, "drive-state", [nonce], now + DRIVE_STATE_TTL_MS);

export async function verifyDriveState(secret: string, state: string, now: number): Promise<{ ok: true; nonce: string } | { ok: false; reason: string }> {
  const t = await unseal(secret, "drive-state", state, 1, now);
  return t.ok ? { ok: true, nonce: t.parts[0] } : t;
}

export type Access = "public" | "ticket" | "protected";

/**
 * Everything under /api/ needs a verified session, except two public routes (a health check that says nothing,
 * and Google's redirect, which carries a state this server signed) and the live socket, which needs a ticket.
 */
export function routeAccess(method: string, path: string): Access {
  if (method === "GET" && (path === "/api/health" || path === "/api/drive/callback")) return "public";
  if (method === "GET" && /^\/api\/runs\/[a-z0-9]{16,40}\/ws$/.test(path)) return "ticket";
  return "protected";
}
