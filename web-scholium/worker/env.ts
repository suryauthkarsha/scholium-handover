// Bindings and secrets the Worker and its Durable Objects receive, and the one way they talk to each other.
import { internalKey, timingSafeEqual } from "../src/shared/gate";

export interface Env {
  ASSETS: Fetcher;
  RUN: DurableObjectNamespace;
  WORKSPACE: DurableObjectNamespace;
  /** Helpers that make model calls beyond what one run can hold open itself. See caller-do.ts. */
  CALLER?: DurableObjectNamespace;
  /** Signs tickets and protects object-to-object calls. */
  SCHOLIUM_SECRET: string;
  /** Rork AI Cloud credential. Server-side only: it is never sent to the browser or to a sandbox. */
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY: string;
  /** Optional. A Rork AI key from another Rork account; when set, every model call goes there instead. See src/shared/modelAccount.ts. */
  MODEL_ACCOUNT_KEY?: string;
  ALERT_EMAIL_TO?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  /** Optional free Stack Exchange app key; raises the daily request allowance. */
  STACKEXCHANGE_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RORK_AUTH_SECRET_KEY?: string;
  RORK_AUTH_URL?: string;
  /** The permanent store (a Postgres database). Server-side only. */
  EXPO_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** This project's id at Rork: the audience sign-in tokens are issued for. Set by Rork for each project. */
  EXPO_PUBLIC_PROJECT_ID?: string;
  /**
   * Optional. One pasted value that carries everything a fresh copy of the site needs to carry on from the
   * permanent store: where the store is and its key, the workspace secret, and the Drive and email settings.
   */
  SCHOLIUM_MOVE_KEY?: string;
}

// ---- The move key ----
const MOVE_PREFIX = "scholium-move-1.";
const MOVE_FIELDS = ["EXPO_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SCHOLIUM_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "RESEND_API_KEY", "RESEND_FROM", "ALERT_EMAIL_TO", "STACKEXCHANGE_KEY"] as const;
type MoveField = (typeof MOVE_FIELDS)[number];

const toB64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64Url = (text: string): string => {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

/** Reads a move key. Returns the settings it carries, or null when it is not a move key. */
export function readMoveKey(key: string | undefined): Partial<Record<MoveField, string>> | null {
  const t = (key ?? "").trim().replace(/\s+/g, "");
  if (!t.startsWith(MOVE_PREFIX)) return null;
  try {
    const o = rec(JSON.parse(fromB64Url(t.slice(MOVE_PREFIX.length))));
    const out: Partial<Record<MoveField, string>> = {};
    for (const f of MOVE_FIELDS) if (typeof o[f] === "string" && o[f]) out[f] = o[f] as string;
    return out.EXPO_PUBLIC_SUPABASE_URL && out.SUPABASE_SERVICE_ROLE_KEY && out.SCHOLIUM_SECRET ? out : null;
  } catch {
    return null;
  }
}

/** Makes the move key for the settings this copy runs on. Null when the permanent store is not set up here. */
export function makeMoveKey(env: Env): string | null {
  if (!env.EXPO_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SCHOLIUM_SECRET) return null;
  const o: Partial<Record<MoveField, string>> = {};
  for (const f of MOVE_FIELDS) if (env[f]) o[f] = env[f];
  return MOVE_PREFIX + toB64Url(JSON.stringify(o));
}

const applied = new WeakMap<object, Env>();
/**
 * The settings this copy really runs on: when a move key is set, what it carries comes first, so a fresh copy on
 * another account reaches the same store, opens the same saved credentials and writes to the same Drive folders.
 */
export function withMoveKey(env: Env): Env {
  const done = applied.get(env);
  if (done) return done;
  const from = readMoveKey(env.SCHOLIUM_MOVE_KEY);
  // Reads of anything the key does not carry fall through to the copy's own settings.
  const out = from ? (Object.assign(Object.create(env) as Env, from) as Env) : env;
  applied.set(env, out);
  return out;
}

export const INTERNAL = "https://scholium.internal";

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
/** The text of JSON.stringify({ entities, events }), a piece at a time, so a long project's state is never held whole as text. */
export function* snapshotText(entities: Record<string, unknown[] | undefined>, events: unknown[]): Generator<string> {
  yield '{"entities":{';
  let firstKind = true;
  for (const [kind, list] of Object.entries(entities)) {
    if (list === undefined) continue;
    yield `${firstKind ? "" : ","}${JSON.stringify(kind)}:[`;
    firstKind = false;
    let first = true;
    for (const e of list) {
      yield `${first ? "" : ","}${JSON.stringify(e) ?? "null"}`;
      first = false;
    }
    yield "]";
  }
  yield `},"events":${JSON.stringify(events)}}`;
}

/** A JSON answer sent as it is written, a few hundred thousand characters at a time. */
export function jsonStream(pieces: Iterator<string>, status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      let buf = "";
      while (buf.length < 250_000) {
        const r = pieces.next();
        if (r.done) {
          if (buf) controller.enqueue(enc.encode(buf));
          controller.close();
          return;
        }
        buf += r.value;
      }
      controller.enqueue(enc.encode(buf));
    },
  });
  return new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export const fail = (status: number, error: string, message: string): Response => json({ error, message }, status);
export const notFound = (): Response => fail(404, "not_found", "There is nothing at this address.");
export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** True when the request carries the key only the router and sibling objects can compute. */
export async function fromInside(request: Request, env: Env): Promise<boolean> {
  const key = request.headers.get("x-scholium-key");
  if (!key || !env.SCHOLIUM_SECRET) return false;
  return timingSafeEqual(key, await internalKey(env.SCHOLIUM_SECRET));
}

/** Calls another object the way the router does. */
export async function callObject(ns: DurableObjectNamespace, name: string, env: Env, ownerHash: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "x-scholium-key": await internalKey(env.SCHOLIUM_SECRET), "x-scholium-owner": ownerHash };
  if (body === undefined) return ns.getByName(name).fetch(`${INTERNAL}${path}`, { method, headers });
  headers["content-type"] = "application/json";
  return ns.getByName(name).fetch(`${INTERNAL}${path}`, { method, headers, body: JSON.stringify(body) });
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return rec(await request.json());
  } catch {
    return {};
  }
}
