// The permanent store. Each Durable Object stays the working copy; everything it writes is also copied,
// continuously and exactly, into a Postgres database the owner controls. A change is first noted in the
// object's own database (so a crash cannot lose the note) and cleared only once the store has accepted it.
// Only one site may write at a time: the store refuses writes from any site that does not hold the lease.
import type { Env } from "./env";

const PART = 500_000;
const BATCH = 1_200_000;
const PAGE_BYTES = 3_000_000;

export interface Lease {
  site: string;
  label: string;
  epoch: number;
}
export interface Unit {
  tbl: string;
  k: string;
  g: number;
}
type Row = { tbl: string; k: string; v: string };
export type Value = string | Uint8Array;
type Sql = (query: string, ...bindings: unknown[]) => Record<string, unknown>[];

export const vaultOn = (env: Env): boolean => !!env.EXPO_PUBLIC_SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;
export const pad = (n: number, width = 10): string => String(Math.max(0, Math.floor(n))).padStart(width, "0");

async function call(env: Env, method: string, path: string, body?: unknown, ms = 60_000): Promise<unknown> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const res = await fetch(`${(env.EXPO_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "")}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`The store answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

const asLease = (v: unknown): Lease | null => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return typeof o.site === "string" && Number.isFinite(Number(o.epoch)) ? { site: o.site, label: String(o.label ?? ""), epoch: Number(o.epoch) } : null;
};

/** Takes the lease when nobody holds it (or always, with force). Returns the lease as it now stands. */
export async function claim(env: Env, site: string, label: string, force: boolean): Promise<Lease> {
  const l = asLease(await call(env, "POST", "rpc/scholium_claim", { p_site: site, p_label: label, p_force: force }, 10_000));
  if (!l) throw new Error("The store did not return a lease.");
  return l;
}

export async function hasRows(env: Env, obj: string): Promise<boolean> {
  const rows = await call(env, "GET", `scholium_rows?select=k&obj=eq.${encodeURIComponent(obj)}&limit=1`, undefined, 15_000);
  return Array.isArray(rows) && rows.length > 0;
}

export async function dropObject(env: Env, lease: Lease, obj: string): Promise<void> {
  await call(env, "POST", "rpc/scholium_drop", { p_site: lease.site, p_epoch: lease.epoch, p_obj: obj });
}

// ---- Values. Text is kept as it is; text Postgres cannot hold, and bytes, are kept as base64. ----
function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const wellFormed = (s: string): boolean => {
  const f = (s as unknown as { isWellFormed?: () => boolean }).isWellFormed;
  return typeof f === "function" ? f.call(s) : !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
};

// Long text is kept gzip-compressed (about a fifth of its size); short text stays readable as it is.
const SQUEEZE_FROM = 600;
async function pipe(bytes: Uint8Array, through: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const w = through.writable.getWriter();
  // A failure shows up on the reading side, which is the one awaited.
  void w
    .write(bytes)
    .then(() => w.close())
    .catch(() => undefined);
  return new Uint8Array(await new Response(through.readable as ReadableStream).arrayBuffer());
}
const gzip = (bytes: Uint8Array): Promise<Uint8Array> => pipe(bytes, new CompressionStream("gzip"));
const gunzip = (bytes: Uint8Array): Promise<Uint8Array> => pipe(bytes, new DecompressionStream("gzip"));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
/** Bytes back to text, exactly: a byte-order mark at the very start is text like any other and is kept. */
const text = (b: Uint8Array): string => {
  const s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? `\ufeff${s}` : s;
};

/**
 * One stored piece starts with a letter saying how it is kept:
 * r text as it is, j JSON text in base64 (text Postgres cannot hold), x bytes in base64,
 * z gzip of the text, y gzip of the JSON text.
 */
async function encodePiece(piece: string): Promise<string> {
  const plain = !piece.includes("\u0000") && wellFormed(piece);
  if (piece.length >= SQUEEZE_FROM) {
    const packed = plain ? `z${b64(await gzip(utf8(piece)))}` : `y${b64(await gzip(utf8(JSON.stringify(piece))))}`;
    if (!plain || packed.length < piece.length) return packed;
  }
  return plain ? `r${piece}` : `j${b64(utf8(JSON.stringify(piece)))}`;
}

export async function encode(value: Value): Promise<string[]> {
  const out: string[] = [];
  if (typeof value !== "string") {
    // 375,000 bytes become exactly 500,000 base64 characters.
    for (let i = 0; i < Math.max(1, value.length); i += 375_000) out.push(`x${b64(value.subarray(i, i + 375_000))}`);
    return out;
  }
  let at = 0;
  do {
    let end = Math.min(value.length, at + PART);
    // Never cut a character in half.
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
    out.push(await encodePiece(value.slice(at, end)));
    at = end;
  } while (at < value.length);
  return out;
}

async function decodePiece(p: string): Promise<string> {
  const tag = p[0];
  if (tag === "r") return p.slice(1);
  if (tag === "j") return JSON.parse(text(unb64(p.slice(1)))) as string;
  if (tag === "z") return text(await gunzip(unb64(p.slice(1))));
  if (tag === "y") return JSON.parse(text(await gunzip(unb64(p.slice(1))))) as string;
  throw new Error("The store holds a piece this version cannot read.");
}

export async function decode(parts: string[]): Promise<Value> {
  if (parts[0]?.startsWith("x")) {
    const chunks = parts.map((p) => unb64(p.slice(1)));
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
  let out = "";
  for (const p of parts) out += await decodePiece(p);
  return out;
}

/** The durable note of what has changed and is not in the store yet. */
export class Dirty {
  private seen = new Set<string>();
  private g = 0;
  paused = false;

  constructor(private sql: Sql) {
    sql("CREATE TABLE IF NOT EXISTS vdirty (tbl TEXT NOT NULL, k TEXT NOT NULL, g INTEGER NOT NULL, PRIMARY KEY (tbl, k)) WITHOUT ROWID");
  }

  mark(tbl: string, k: string): void {
    if (this.paused) return;
    const id = `${tbl}\t${k}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (!this.g) this.g = Number(this.sql("SELECT max(g) AS g FROM vdirty")[0]?.g ?? 0) + 1;
    this.sql("INSERT OR REPLACE INTO vdirty VALUES (?, ?, ?)", tbl, k, this.g++);
  }

  take(limit: number): Unit[] {
    const out = this.sql("SELECT tbl, k, g FROM vdirty ORDER BY g LIMIT ?", limit).map((r) => ({ tbl: String(r.tbl), k: String(r.k), g: Number(r.g) }));
    // Anything changed again from here on is noted afresh, so it cannot be cleared by mistake.
    for (const u of out) this.seen.delete(`${u.tbl}\t${u.k}`);
    return out;
  }

  done(units: Unit[]): void {
    for (const u of units) this.sql("DELETE FROM vdirty WHERE tbl = ? AND k = ? AND g = ?", u.tbl, u.k, u.g);
  }

  count(): number {
    return Number(this.sql("SELECT count(*) AS n FROM vdirty")[0]?.n ?? 0);
  }

  /** True while a change to this unit is still on its way to the store. */
  has(tbl: string, k: string): boolean {
    return this.sql("SELECT 1 AS x FROM vdirty WHERE tbl = ? AND k = ? LIMIT 1", tbl, k).length > 0;
  }

  reset(): void {
    this.sql("DELETE FROM vdirty");
    this.seen.clear();
  }
}

export interface Source {
  /** The whole current value of one unit, or null when it no longer exists. */
  unit(tbl: string, k: string): Value | null;
  /** Activity events after a sequence number, oldest first. Events are only ever added, so a mark is enough. */
  events?(after: number, limit: number): { seq: number; data: string }[];
  eventMark?(): number;
  setEventMark?(seq: number): void;
}

export type FlushResult = "ok" | "standby" | "error" | "idle";

export class Mirror {
  private running: Promise<FlushResult> | null = null;
  lastOkAt = 0;
  error = "";

  constructor(
    private env: Env,
    private obj: string,
    private dirty: Dirty,
    private src: Source,
    private lease: () => Lease | null,
  ) {}

  pending(): number {
    return this.dirty.count();
  }

  flush(): Promise<FlushResult> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<FlushResult> {
    try {
      for (let guard = 0; guard < 400; guard++) {
        const lease = this.lease();
        if (!lease) return "idle";
        const units = this.dirty.take(150);
        const mark = this.src.eventMark?.() ?? 0;
        const events = this.src.events?.(mark, 400) ?? [];
        if (!units.length && !events.length) break;
        let del: { tbl: string; k: string }[] = [];
        let put: Row[] = [];
        let size = 0;
        let finished: Unit[] = [];
        let standby = false;
        const send = async (): Promise<void> => {
          if (!del.length && !put.length) return;
          const r = await call(this.env, "POST", "rpc/scholium_apply", { p_site: lease.site, p_epoch: lease.epoch, p_obj: this.obj, p_del: del, p_put: put });
          if (r !== "ok") {
            standby = true;
            throw new Error("standby");
          }
          this.dirty.done(finished);
          del = [];
          put = [];
          finished = [];
          size = 0;
        };
        const add = async (row: Row): Promise<void> => {
          if (put.length && size + row.v.length > BATCH) await send();
          put.push(row);
          size += row.v.length + row.k.length + 40;
        };
        try {
          for (const u of units) {
            const value = this.src.unit(u.tbl, u.k);
            del.push({ tbl: u.tbl, k: u.k });
            if (value !== null) {
              const parts = await encode(value);
              for (let i = 0; i < parts.length; i++) await add({ tbl: u.tbl, k: `${u.k}\t${pad(i, 5)}`, v: parts[i] });
            }
            finished.push(u);
          }
          let top = mark;
          for (const e of events) {
            await add({ tbl: "ev", k: `${pad(e.seq, 12)}\t${pad(0, 5)}`, v: (await encode(e.data))[0] });
            top = Math.max(top, e.seq);
          }
          await send();
          if (top > mark) this.src.setEventMark?.(top);
        } catch (err) {
          if (standby) return "standby";
          throw err;
        }
      }
      this.lastOkAt = Date.now();
      this.error = "";
      return "ok";
    } catch (err) {
      this.error = String(err instanceof Error ? err.message : err).slice(0, 200);
      return "error";
    }
  }
}

/** One line of a check of the store against this copy of the site. */
export interface Tally {
  /** Items the store holds. */
  store: number;
  /** Of those, identical to what is here, character for character. */
  same: number;
  /** Different here, with no change on its way that would explain it. */
  differ: number;
  /** In the store but not here. */
  extra: number;
  /** Changed here a moment ago and on its way. */
  moving: number;
}
export const newTally = (): Tally => ({ store: 0, same: 0, differ: 0, extra: 0, moving: 0 });
export function sameValue(a: Value | null, b: Value): boolean {
  if (a === null) return false;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface StoredUnit {
  tbl: string;
  k: string;
  value: Value;
}
export interface Cursor {
  tbl: string;
  k: string;
}
export interface RestoreResult {
  /** Whole units handed over in this call. */
  count: number;
  /** True when the end of the object was reached. */
  done: boolean;
  /** Where the next call carries on: just after the last whole unit handed over. */
  cursor: Cursor;
}

/**
 * Reads one object back from the store, whole unit by whole unit, in key order. It can stop after a number of
 * pages and be carried on later from the cursor it returns, so an object of any size can be read back in steps.
 * Each call to onPage gets the cursor that is true once those units are kept, so both can be saved together.
 */
export async function restore(env: Env, obj: string, onPage: (units: StoredUnit[], cursor: Cursor) => void | Promise<void>, opts: { from?: Cursor; maxPages?: number } = {}): Promise<RestoreResult> {
  let after: Cursor = opts.from ?? { tbl: "", k: "" };
  let safe: Cursor = after;
  let cur: { tbl: string; k: string; parts: string[] } | null = null;
  let count = 0;
  let closedAny = false;
  const maxPages = opts.maxPages ?? 20_000;
  for (let page = 0; page < 20_000; page++) {
    // Stop only between whole units, and only once this call has got somewhere.
    if (page >= maxPages && closedAny) return { count, done: false, cursor: safe };
    const rows = (await call(env, "POST", "rpc/scholium_page", { p_obj: obj, p_tbl: after.tbl, p_k: after.k, p_bytes: PAGE_BYTES })) as Row[];
    if (!Array.isArray(rows)) throw new Error("The store returned something unreadable.");
    const out: StoredUnit[] = [];
    let last: Cursor = after;
    let pageSafe = safe;
    const close = async (): Promise<void> => {
      if (cur) {
        out.push({ tbl: cur.tbl, k: cur.k, value: await decode(cur.parts) });
        pageSafe = last;
      }
      cur = null;
    };
    for (const r of rows) {
      const k = r.k.slice(0, r.k.lastIndexOf("\t"));
      if (cur && (cur.tbl !== r.tbl || cur.k !== k)) await close();
      cur ??= { tbl: r.tbl, k, parts: [] };
      cur.parts.push(r.v);
      last = { tbl: r.tbl, k: r.k };
    }
    after = last;
    if (!rows.length) await close();
    count += out.length;
    if (out.length || !rows.length) {
      await onPage(out, pageSafe);
      safe = pageSafe;
      if (out.length) closedAny = true;
    }
    if (!rows.length) return { count, done: true, cursor: safe };
  }
  throw new Error("The store held more than could be read back in one go.");
}

/** A copy of the site's own code kept in the store, so it can be taken to another account. */
export async function codeInfo(env: Env): Promise<{ at: string; bytes: number; files: number; sha: string } | null> {
  const rows = (await call(env, "GET", "scholium_code?select=at,bytes,files,sha&id=eq.1", undefined, 15_000)) as Record<string, unknown>[];
  const r = Array.isArray(rows) ? rows[0] : undefined;
  return r ? { at: String(r.at ?? ""), bytes: Number(r.bytes ?? 0), files: Number(r.files ?? 0), sha: String(r.sha ?? "") } : null;
}
export async function codeData(env: Env): Promise<Uint8Array | null> {
  const rows = (await call(env, "GET", "scholium_code?select=data&id=eq.1", undefined, 60_000)) as Record<string, unknown>[];
  const r = Array.isArray(rows) ? rows[0] : undefined;
  return r && typeof r.data === "string" ? unb64(r.data) : null;
}
export async function storeSize(env: Env): Promise<number | null> {
  try {
    const n = Number(await call(env, "POST", "rpc/scholium_size", {}, 10_000));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
