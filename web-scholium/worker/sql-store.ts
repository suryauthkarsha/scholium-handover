// The run's storage: the engine's `Store` on a Durable Object's own SQLite database.
// Every statement is synchronous, so a group of writes inside `transaction` is atomic.
import type { SearchHit, Store, StoredEntity } from "../src/engine/store";
import { keyTerms } from "../src/engine/util";
import type { ActivityEvent, EntityKind, Msg } from "../src/shared/types";
import { type Dirty, pad, type Source, type Value } from "./vault";

const CHUNK = 400_000;
const TEXT_CHUNK = 300_000;
const BLOB_CHUNK = 1_000_000;
const FTS_CHUNK = 200_000;
const KEEP_EVENTS = 5000;

type Row = Record<string, unknown>;

/** Bookkeeping that belongs to this copy of the site alone and is never sent to the permanent store. */
const local = (k: string): boolean => k.startsWith("nonce:") || k.startsWith("vault:");

export class SqlStore implements Store, Source {
  /** Rows written and read since this object woke up, for the free-allowance guard. */
  written = 0;
  read = 0;
  private fts = true;
  private appended = 0;
  /** When set, every change is also noted for the permanent store. */
  dirty: Dirty | null = null;

  constructor(private storage: DurableObjectStorage) {
    this.q("CREATE TABLE IF NOT EXISTS ent (kind TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id, part)) WITHOUT ROWID");
    this.q("CREATE TABLE IF NOT EXISTS msg (task TEXT NOT NULL, idx INTEGER NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (task, idx, part)) WITHOUT ROWID");
    this.q("CREATE TABLE IF NOT EXISTS ev (seq INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    this.q("CREATE TABLE IF NOT EXISTS txt (ref TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (ref, part)) WITHOUT ROWID");
    this.q("CREATE TABLE IF NOT EXISTS blob (ref TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (ref, part)) WITHOUT ROWID");
    this.q("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID");
    try {
      this.q("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, body, ref UNINDEXED, kind UNINDEXED)");
      this.q("CREATE TABLE IF NOT EXISTS ftsmap (ref TEXT NOT NULL, rid INTEGER NOT NULL, PRIMARY KEY (ref, rid)) WITHOUT ROWID");
    } catch {
      this.fts = false;
      this.q("CREATE TABLE IF NOT EXISTS doc (ref TEXT NOT NULL, part INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (ref, part)) WITHOUT ROWID");
    }
  }

  private q(query: string, ...bindings: unknown[]): Row[] {
    const cursor = this.storage.sql.exec(query, ...bindings);
    const rows = cursor.toArray() as Row[];
    this.read += cursor.rowsRead;
    this.written += cursor.rowsWritten;
    return rows;
  }

  private putParts(table: "ent" | "txt", where: string, keys: unknown[], text: string, size: number): void {
    const n = Math.max(1, Math.ceil(text.length / size));
    for (let i = 0; i < n; i++) this.q(`INSERT OR REPLACE INTO ${table} VALUES (${keys.map(() => "?").join(",")}, ?, ?)`, ...keys, i, text.slice(i * size, (i + 1) * size));
    this.q(`DELETE FROM ${table} WHERE ${where} AND part >= ?`, ...keys, n);
  }

  loadEntities(): StoredEntity[] {
    const out: StoredEntity[] = [];
    let cur: { kind: string; id: string; text: string } | null = null;
    const push = (): void => {
      if (!cur) return;
      try {
        out.push({ kind: cur.kind as EntityKind, id: cur.id, data: JSON.parse(cur.text) });
      } catch {
        // A row that cannot be parsed is skipped rather than stopping the run from loading.
      }
    };
    for (const r of this.q("SELECT kind, id, data FROM ent ORDER BY kind, id, part")) {
      const kind = String(r.kind);
      const id = String(r.id);
      if (cur && cur.kind === kind && cur.id === id) cur.text += String(r.data);
      else {
        push();
        cur = { kind, id, text: String(r.data) };
      }
    }
    push();
    return out;
  }

  putEntity(kind: EntityKind, id: string, data: unknown): void {
    this.putParts("ent", "kind = ? AND id = ?", [kind, id], JSON.stringify(data), CHUNK);
    this.dirty?.mark("ent", `${kind}\t${id}`);
  }

  delEntity(kind: EntityKind, id: string): void {
    this.q("DELETE FROM ent WHERE kind = ? AND id = ?", kind, id);
    this.dirty?.mark("ent", `${kind}\t${id}`);
  }

  loadMsgs(taskId: string): Msg[] {
    const out: Msg[] = [];
    let idx = -1;
    let text = "";
    const push = (): void => {
      if (idx < 0) return;
      try {
        out.push(JSON.parse(text) as Msg);
      } catch {
        out.push({ role: "user", text: "[A stored message could not be read back.]", origin: "system" });
      }
    };
    for (const r of this.q("SELECT idx, data FROM msg WHERE task = ? ORDER BY idx, part", taskId)) {
      const i = Number(r.idx);
      if (i === idx) text += String(r.data);
      else {
        push();
        idx = i;
        text = String(r.data);
      }
    }
    push();
    return out;
  }

  writeMsgs(taskId: string, from: number, msgs: Msg[]): void {
    // Messages being dropped from the end are noted first, so the permanent store drops them too.
    if (this.dirty) for (const r of this.q("SELECT DISTINCT idx FROM msg WHERE task = ? AND idx >= ?", taskId, from + msgs.length)) this.dirty.mark("msg", `${taskId}\t${pad(Number(r.idx))}`);
    this.q("DELETE FROM msg WHERE task = ? AND idx >= ?", taskId, from);
    msgs.forEach((m, k) => {
      this.dirty?.mark("msg", `${taskId}\t${pad(from + k)}`);
      const text = JSON.stringify(m);
      const n = Math.max(1, Math.ceil(text.length / CHUNK));
      for (let i = 0; i < n; i++) this.q("INSERT OR REPLACE INTO msg VALUES (?, ?, ?, ?)", taskId, from + k, i, text.slice(i * CHUNK, (i + 1) * CHUNK));
    });
  }

  appendEvent(e: ActivityEvent): void {
    this.q("INSERT OR REPLACE INTO ev VALUES (?, ?)", e.seq, JSON.stringify(e));
    if (++this.appended % 250 === 0) this.q("DELETE FROM ev WHERE seq < ?", e.seq - KEEP_EVENTS);
  }

  loadEvents(limit: number): ActivityEvent[] {
    const out: ActivityEvent[] = [];
    for (const r of this.q("SELECT data FROM ev ORDER BY seq DESC LIMIT ?", limit)) {
      try {
        out.push(JSON.parse(String(r.data)) as ActivityEvent);
      } catch {
        // skip
      }
    }
    return out.reverse();
  }

  putText(ref: string, text: string): void {
    this.dirty?.mark("txt", ref);
    if (!text) this.q("DELETE FROM txt WHERE ref = ?", ref);
    else this.putParts("txt", "ref = ?", [ref], text, TEXT_CHUNK);
  }

  getText(ref: string): string | null {
    const rows = this.q("SELECT data FROM txt WHERE ref = ? ORDER BY part", ref);
    return rows.length ? rows.map((r) => String(r.data)).join("") : null;
  }

  putBlob(ref: string, bytes: Uint8Array): void {
    this.dirty?.mark("blob", ref);
    this.q("DELETE FROM blob WHERE ref = ?", ref);
    for (let i = 0, part = 0; i < bytes.length; i += BLOB_CHUNK, part++) {
      const piece = bytes.slice(i, i + BLOB_CHUNK);
      this.q("INSERT INTO blob VALUES (?, ?, ?)", ref, part, piece.buffer);
    }
  }

  getBlob(ref: string): Uint8Array | null {
    const rows = this.q("SELECT data FROM blob WHERE ref = ? ORDER BY part", ref);
    if (!rows.length) return null;
    const parts = rows.map((r) => new Uint8Array(r.data as ArrayBuffer));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  indexDoc(ref: string, kind: string, title: string, text: string): void {
    if (!this.fts) {
      this.q("DELETE FROM doc WHERE ref = ?", ref);
      const n = text || title ? Math.max(1, Math.ceil(text.length / FTS_CHUNK)) : 0;
      for (let i = 0; i < n; i++) this.q("INSERT INTO doc VALUES (?, ?, ?, ?, ?)", ref, i, kind, title, text.slice(i * FTS_CHUNK, (i + 1) * FTS_CHUNK));
      return;
    }
    for (const r of this.q("SELECT rid FROM ftsmap WHERE ref = ?", ref)) this.q("DELETE FROM fts WHERE rowid = ?", Number(r.rid));
    this.q("DELETE FROM ftsmap WHERE ref = ?", ref);
    if (!text && !title) return;
    const n = Math.max(1, Math.ceil(text.length / FTS_CHUNK));
    for (let i = 0; i < n; i++) {
      this.q("INSERT INTO fts (title, body, ref, kind) VALUES (?, ?, ?, ?)", title, text.slice(i * FTS_CHUNK, (i + 1) * FTS_CHUNK), ref, kind);
      const rid = Number(this.q("SELECT last_insert_rowid() AS rid")[0]?.rid ?? 0);
      if (rid) this.q("INSERT OR REPLACE INTO ftsmap VALUES (?, ?)", ref, rid);
    }
  }

  search(query: string, limit: number, kinds?: string[]): SearchHit[] {
    const terms = (keyTerms(query).length ? keyTerms(query) : query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1)).slice(0, 12).map((t) => t.replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean);
    if (!terms.length) return [];
    const kindSql = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    if (this.fts) {
      const match = terms.map((t) => `"${t}"*`).join(" OR ");
      let rows: Row[] = [];
      try {
        rows = this.q(`SELECT ref, kind, title, snippet(fts, 1, '', '', ' … ', 28) AS snip, bm25(fts, 4.0, 1.0) AS rank FROM fts WHERE fts MATCH ?${kindSql} ORDER BY rank LIMIT ?`, match, ...(kinds ?? []), limit * 3);
      } catch {
        rows = [];
      }
      for (const r of rows) {
        const ref = String(r.ref);
        if (seen.has(ref)) continue;
        seen.add(ref);
        out.push({ ref, kind: String(r.kind), title: String(r.title), snippet: String(r.snip ?? ""), score: -Number(r.rank ?? 0) });
        if (out.length >= limit) break;
      }
      return out;
    }
    const like = terms.map(() => "(lower(title) LIKE ? OR lower(body) LIKE ?)").join(" OR ");
    const args = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
    for (const r of this.q(`SELECT ref, kind, title, body FROM doc WHERE (${like})${kindSql} LIMIT ?`, ...args, ...(kinds ?? []), limit * 4)) {
      const ref = String(r.ref);
      if (seen.has(ref)) continue;
      seen.add(ref);
      const body = String(r.body);
      const low = `${String(r.title)} ${body}`.toLowerCase();
      const at = Math.max(0, body.toLowerCase().indexOf(terms[0]) - 80);
      out.push({ ref, kind: String(r.kind), title: String(r.title), snippet: body.slice(at, at + 240), score: terms.filter((t) => low.includes(t)).length });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  transaction(fn: () => void): void {
    this.storage.transactionSync(fn);
  }

  // ---- A small key-value table for the object's own bookkeeping (not part of the engine's Store). ----
  kvGet<T>(k: string): T | undefined {
    const r = this.q("SELECT v FROM kv WHERE k = ?", k)[0];
    if (!r) return undefined;
    try {
      return JSON.parse(String(r.v)) as T;
    } catch {
      return undefined;
    }
  }

  kvSet(k: string, v: unknown): void {
    this.q("INSERT OR REPLACE INTO kv VALUES (?, ?)", k, JSON.stringify(v));
    if (!local(k)) this.dirty?.mark("kv", k);
  }

  kvDel(k: string): void {
    this.q("DELETE FROM kv WHERE k = ?", k);
    if (!local(k)) this.dirty?.mark("kv", k);
  }

  kvPrefix<T>(prefix: string): { k: string; v: T }[] {
    const out: { k: string; v: T }[] = [];
    for (const r of this.q("SELECT k, v FROM kv WHERE k >= ? AND k < ? ORDER BY k", prefix, `${prefix}\uffff`)) {
      try {
        out.push({ k: String(r.k), v: JSON.parse(String(r.v)) as T });
      } catch {
        // skip
      }
    }
    return out;
  }

  // ---- The permanent store: reading whole units out, and putting them back exactly as they were. ----
  private join(rows: Row[]): string | null {
    return rows.length ? rows.map((r) => String(r.data)).join("") : null;
  }

  unit(tbl: string, k: string): Value | null {
    const cut = k.lastIndexOf("\t");
    if (tbl === "ent") return this.join(this.q("SELECT data FROM ent WHERE kind = ? AND id = ? ORDER BY part", k.slice(0, k.indexOf("\t")), k.slice(k.indexOf("\t") + 1)));
    if (tbl === "msg") return this.join(this.q("SELECT data FROM msg WHERE task = ? AND idx = ? ORDER BY part", k.slice(0, cut), Number(k.slice(cut + 1))));
    if (tbl === "txt") return this.join(this.q("SELECT data FROM txt WHERE ref = ? ORDER BY part", k));
    if (tbl === "blob") return this.getBlob(k);
    if (tbl === "kv") {
      const r = this.q("SELECT v FROM kv WHERE k = ?", k)[0];
      return r ? String(r.v) : null;
    }
    return null;
  }

  events(after: number, limit: number): { seq: number; data: string }[] {
    return this.q("SELECT seq, data FROM ev WHERE seq > ? ORDER BY seq LIMIT ?", after, limit).map((r) => ({ seq: Number(r.seq), data: String(r.data) }));
  }

  eventMark(): number {
    return this.kvGet<number>("vault:evSeq") ?? 0;
  }

  setEventMark(seq: number): void {
    this.kvSet("vault:evSeq", seq);
  }

  /** Writes one unit read back from the permanent store, without noting it as a change. */
  rawPut(tbl: string, k: string, value: Value): void {
    const held = this.dirty;
    this.dirty = null;
    try {
      const cut = k.lastIndexOf("\t");
      if (typeof value !== "string") {
        if (tbl === "blob") this.putBlob(k, value);
      } else if (tbl === "ent") this.putParts("ent", "kind = ? AND id = ?", [k.slice(0, k.indexOf("\t")), k.slice(k.indexOf("\t") + 1)], value, CHUNK);
      else if (tbl === "msg") {
        const n = Math.max(1, Math.ceil(value.length / CHUNK));
        for (let i = 0; i < n; i++) this.q("INSERT OR REPLACE INTO msg VALUES (?, ?, ?, ?)", k.slice(0, cut), Number(k.slice(cut + 1)), i, value.slice(i * CHUNK, (i + 1) * CHUNK));
      } else if (tbl === "txt") this.putParts("txt", "ref = ?", [k], value, TEXT_CHUNK);
      else if (tbl === "kv") {
        if (!local(k)) this.q("INSERT OR REPLACE INTO kv VALUES (?, ?)", k, value);
      } else if (tbl === "ev") this.q("INSERT OR REPLACE INTO ev VALUES (?, ?)", Number(k), value);
    } finally {
      this.dirty = held;
    }
  }

  /** Empties the run's database, keeping only this copy's own bookkeeping. */
  wipe(): void {
    for (const t of ["ent", "msg", "ev", "txt", "blob"]) this.q(`DELETE FROM ${t}`);
    this.q("DELETE FROM kv WHERE k NOT LIKE 'vault:%'");
    if (this.fts) {
      this.q("DELETE FROM fts");
      this.q("DELETE FROM ftsmap");
    } else this.q("DELETE FROM doc");
    this.dirty?.reset();
  }

  /** Keeps only the most recent events here, as the run itself does; the permanent store keeps them all. */
  trimEvents(): number {
    const top = Number(this.q("SELECT max(seq) AS s FROM ev")[0]?.s ?? 0);
    this.q("DELETE FROM ev WHERE seq < ?", top - KEEP_EVENTS);
    return top;
  }

  /** Notes everything as changed, so the whole run is copied to the permanent store. */
  markAll(): void {
    const d = this.dirty;
    if (!d) return;
    for (const r of this.q("SELECT DISTINCT kind, id FROM ent")) d.mark("ent", `${String(r.kind)}\t${String(r.id)}`);
    for (const r of this.q("SELECT DISTINCT task, idx FROM msg")) d.mark("msg", `${String(r.task)}\t${pad(Number(r.idx))}`);
    for (const r of this.q("SELECT DISTINCT ref FROM txt")) d.mark("txt", String(r.ref));
    for (const r of this.q("SELECT DISTINCT ref FROM blob")) d.mark("blob", String(r.ref));
    for (const r of this.q("SELECT k FROM kv")) if (!local(String(r.k))) d.mark("kv", String(r.k));
    this.setEventMark(0);
  }

  /** How many items of each sort this copy holds, named as the store names them. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    const n = (query: string): number => Number(this.q(query)[0]?.n ?? 0);
    for (const r of this.q("SELECT kind, count(*) AS n FROM ent WHERE part = 0 GROUP BY kind")) out[`ent:${String(r.kind)}`] = Number(r.n);
    out.msg = n("SELECT count(*) AS n FROM msg WHERE part = 0");
    out.txt = n("SELECT count(*) AS n FROM txt WHERE part = 0");
    out.blob = n("SELECT count(*) AS n FROM blob WHERE part = 0");
    out.ev = n("SELECT count(*) AS n FROM ev");
    out.kv = n("SELECT count(*) AS n FROM kv WHERE k NOT LIKE 'vault:%' AND k NOT LIKE 'nonce:%'");
    return out;
  }

  /** One activity event as it is kept here, or null when this copy no longer keeps it. */
  eventAt(seq: number): string | null {
    const r = this.q("SELECT data FROM ev WHERE seq = ?", seq)[0];
    return r ? String(r.data) : null;
  }

  /** For objects that keep their own change notes in this database. */
  sql(query: string, ...bindings: unknown[]): Row[] {
    return this.q(query, ...bindings);
  }
}
