// A rehearsal of opening every project on a fresh copy of the site, measuring the memory each step needs.
// It uses the site's own storage code (worker/sql-store.ts) on a real SQLite database kept in a temporary folder,
// fills it from the permanent store exactly as "Continue here" does, opens it with the site's own engine, and then
// does what the site does for a viewer. The permanent store is only read; no model is called; nothing is published.
//
// The site runs on V8 with 128 MB of memory, so this must run on V8 too (Node, not Bun):
//   bun build web-scholium/scripts/memory-rehearsal.ts --target=node --outfile "$TMPDIR/memory-rehearsal.mjs"
//   node --expose-gc --max-old-space-size=110 "$TMPDIR/memory-rehearsal.mjs"
// Needs SCHOLIUM_MOVE_KEY in the environment. MEM_DIR names the temporary folder (default: the system's).
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";

import { buildBackup, checkpoint, driveFiles, type CheckpointExport } from "../src/engine/background";
import { Engine } from "../src/engine/engine";
import { buildDigest, buildReport, dataFrom, toLatex } from "../src/engine/report";
import type { Services } from "../src/engine/services";
import { ALLOWED_EMAIL, ownerHashFor } from "../src/shared/gate";
import { ENTITY_KINDS } from "../src/shared/types";
import { json, jsonStream, readMoveKey, snapshotText, type Env } from "../worker/env";
import { SqlStore } from "../worker/sql-store";
import { encode, encodeFrom, restore, sameValue } from "../worker/vault";

const read = (k: string): string => process.env[k] ?? "";
const move = readMoveKey(read("SCHOLIUM_MOVE_KEY"));
const url = (move?.EXPO_PUBLIC_SUPABASE_URL ?? read("EXPO_PUBLIC_SUPABASE_URL")).replace(/\/+$/, "");
const key = move?.SUPABASE_SERVICE_ROLE_KEY ?? read("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) throw new Error("The store's address and key are needed: set SCHOLIUM_MOVE_KEY.");
const env = {
  EXPO_PUBLIC_SUPABASE_URL: url,
  SUPABASE_SERVICE_ROLE_KEY: key,
} as Env;
const dir = read("MEM_DIR") || tmpdir();
mkdirSync(dir, { recursive: true });
const only = new Set(read("MEM_STEPS").split(",").filter(Boolean));
const want = (step: string): boolean => !only.size || only.has(step);

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("Run with: node --expose-gc");
const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
/** Everything that counts against the site's limit: the JavaScript heap and the buffers outside it. */
const used = (): number => {
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
};
let top = 0;
/** The buffers outside the JavaScript heap at their largest. Node's heap limit does not count them; the site's limit does. */
let topOutside = 0;
const sample = (): void => {
  top = Math.max(top, used());
  topOutside = Math.max(topOutside, process.memoryUsage().external);
};
const settle = (): number => {
  gc();
  gc();
  return used();
};
const same = (what: string, ok: boolean): void => {
  console.log(`  ${ok ? "IDENTICAL" : "DIFFERENT"}: ${what}.`);
  if (!ok) process.exitCode = 1;
};
async function step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const before = settle();
  top = before;
  topOutside = 0;
  const timer = setInterval(sample, 5);
  try {
    const out = await fn();
    sample();
    const after = settle();
    console.log(`  ${name.padEnd(44)} held before ${mb(before).padStart(9)}, highest seen ${mb(top).padStart(9)}, held after ${mb(after).padStart(9)}`);
    return out;
  } finally {
    clearInterval(timer);
  }
}

/** The part of a Durable Object's storage the site uses, on an ordinary SQLite file. SQLite's own memory is outside the limit there too. */
function storage(file: string): DurableObjectStorage {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
  let depth = 0;
  const exec = (query: string, ...bindings: unknown[]): unknown => {
    const stmt = db.prepare(query);
    const args = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as never[];
    const cur = { rowsRead: 0, rowsWritten: 0 } as Record<string, unknown> & {
      rowsRead: number;
      rowsWritten: number;
    };
    let it: Iterator<unknown>;
    if (stmt.columns().length) it = stmt.iterate(...args) as unknown as Iterator<unknown>;
    else {
      cur.rowsWritten = Number(stmt.run(...args).changes);
      it = [][Symbol.iterator]();
    }
    const next = (): IteratorResult<unknown> => {
      const r = it.next();
      if (!r.done) {
        cur.rowsRead++;
        sample();
      }
      return r;
    };
    cur.next = next;
    cur[Symbol.iterator as unknown as string] = () => ({ next });
    cur.toArray = () => {
      const rows: unknown[] = [];
      for (let r = next(); !r.done; r = next()) rows.push(r.value);
      return rows;
    };
    return cur;
  };
  return {
    sql: { exec },
    transactionSync: (fn: () => void) => {
      if (depth++) return fn();
      db.exec("BEGIN");
      try {
        fn();
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth = 0;
      }
    },
  } as unknown as DurableObjectStorage;
}

// The engine is only opened, never run: anything that would reach a model or the web stops the rehearsal.
const services = new Proxy({ now: () => Date.now() } as Services, {
  get: (t, p) => {
    if (p === "now") return t.now;
    throw new Error(`The rehearsal tried to use "${String(p)}", which it must never do.`);
  },
});

/**
 * What a new project does when it is branched from a checkpoint (worker/run-do.ts, init and pull): takes the checkpoint in,
 * builds itself from it, then copies the source texts and uploaded files across. `from` is the storage of the project branched from.
 * The new project lives in its own temporary file; the permanent store is not touched.
 */
async function branch(from: SqlStore, id: string, ck: string, handed: string): Promise<void> {
  const file = join(dir, `scholium-rehearsal-branch-${id}.sqlite`);
  rmSync(file, { force: true });
  const store = new SqlStore(storage(file));
  const eng = new Engine(store, services, {
    broadcast: () => {},
    wake: () => {},
  });
  await step(`Branch from ${ck}: the new project, start to finish`, async () => {
    const res = new Response(Readable.toWeb(createReadStream(handed)) as unknown as ReadableStream<Uint8Array>);
    const imported = (await res.json()) as CheckpointExport;
    sample();
    console.log(`  Checkpoint taken in: ${mb(used())} held.`);
    eng.init({
      id: "rehearsalbranch00",
      ownerHash: "rehearsal",
      config: imported.config,
      import: imported,
      branchedFrom: { runId: id, checkpointId: ck },
    });
    store.kvSet("meta", { id: "rehearsalbranch00", owner: "rehearsal" });
    sample();
    console.log(`  New project built from it: ${mb(used())} held.`);
    let ids = (imported.entities.source ?? []).map((s) => s.id);
    let texts = 0;
    for (let guard = 0; ids.length && guard < 200; guard++) {
      // The other project's side of it (/internal/pull-texts), then this side.
      const batch: Record<string, string> = {};
      const rest: string[] = [];
      let size = 0;
      for (const sid of ids) {
        if (size > 3_000_000) {
          rest.push(sid);
          continue;
        }
        batch[sid] = from.getText(`src:${sid}`) ?? "";
        size += batch[sid].length;
      }
      const out = (await json({ texts: batch, rest }).json()) as {
        texts: Record<string, string>;
        rest: string[];
      };
      for (const [sid, text] of Object.entries(out.texts))
        if (text) {
          eng.importText(sid, text);
          texts++;
        }
      ids = out.rest;
      sample();
    }
    let files = 0;
    for (const u of imported.entities.upload ?? []) {
      const bytes = from.getBlob(`up:${u.id}`);
      if (!bytes) continue;
      eng.importBlob(u.id, new Uint8Array(await new Response(bytes).arrayBuffer()));
      files++;
      sample();
    }
    eng.flush();
    console.log(`  ${texts} source texts and ${files} uploaded files copied across.`);
  });
  console.log(`  Of the highest seen, outside the JavaScript heap: ${mb(topOutside)}.`);
  rmSync(file, { force: true });
}

const ws: string[] = [];
await restore(env, `ws:${await ownerHashFor(ALLOWED_EMAIL)}`, (units) => {
  for (const u of units) if (u.k.startsWith("run:")) ws.push(u.k.slice(4));
});
console.log(`Store: ${new URL(url).host}. Projects: ${ws.length}. Node ${process.version}, heap limit ${mb((await import("node:v8")).getHeapStatistics().heap_size_limit)}.`);

for (const id of ws) {
  console.log(`\nProject ${id.slice(0, 8)}…`);
  const file = join(dir, `scholium-rehearsal-${id}.sqlite`);
  const fresh = !existsSync(file);
  const store = new SqlStore(storage(file));

  // 1. Read the project back from the store the way the site does after "Continue here" (worker/run-do.ts, pullStore).
  if (fresh) {
    await step("Reading the project back from the store", async () => {
      let first = true;
      let n = 0;
      let differ = 0;
      await restore(env, `run:${id}`, (units) => {
        sample();
        store.transaction(() => {
          if (first) store.wipe();
          first = false;
          for (const u of units) store.rawPut(u.tbl, u.k, u.value, u.pieces);
          n += units.length;
        });
        sample();
        // Asked for separately, as it needs memory of its own: what was just kept must be what the store holds, character for character.
        if (read("MEM_VERIFY")) for (const u of units) if (u.tbl !== "ev" ? !sameValue(store.unit(u.tbl, u.k), u.value) : store.eventAt(Number(u.k)) !== u.value) differ++;
      });
      if (read("MEM_VERIFY")) same(`Everything read back, ${n.toLocaleString("en-US")} items`, differ === 0);
      store.rawPut("kv", "meta", JSON.stringify({ id, owner: "rehearsal" }));
      store.setEventMark(store.trimEvents());
      console.log(`  ${n.toLocaleString("en-US")} items kept.`);
    });
  } else console.log("  Using the copy already read back into the temporary folder.");

  // The new project alone, as when it does not share its memory with the project it is branched from.
  // Needs the checkpoint a run with MEM_STEPS=ckdown left in the temporary folder.
  const handedOver = (): { ck: string; file: string } | null => {
    const m = readdirSync(dir)
      .map((f) => new RegExp(`^scholium-rehearsal-${id}\\.checkpoint-([A-Za-z0-9_-]+)\\.json$`).exec(f))
      .find(Boolean);
    return m ? { ck: m[1], file: join(dir, m[0]) } : null;
  };
  if (read("MEM_APART")) {
    const h = handedOver();
    if (!h) throw new Error("Run with MEM_STEPS=ckdown first.");
    await branch(store, id, h.ck, h.file);
    continue;
  }

  // 2. Open it with the site's own engine.
  const eng = new Engine(store, services, {
    broadcast: () => {},
    wake: () => {},
  });
  const opened = await step("Opening the project (engine load)", () => eng.load());
  if (!opened) {
    console.log("  The engine could not open the project.");
    process.exitCode = 1;
    continue;
  }
  const run = eng.run;
  console.log(`  Opened: status ${run.status}, cycle ${run.cycle}, spent $${run.spend.usd.toFixed(2)}; ${ENTITY_KINDS.map((k) => `${eng.all(k).length} ${k}`).join(", ")}.`);
  if (fresh) await step("Rebuilding the search index", () => eng.reindex());

  let sent: { bytes: number; sha: string; events: unknown[] } | null = null;
  // 3. What a viewer's page asks for.
  if (want("ws"))
    await step("Live connection: whole state in pieces", () => {
      const snap = eng.publicSnapshot();
      let sent = 0;
      for (const kind of ENTITY_KINDS) for (const data of (snap[kind] ?? []) as { id: string }[]) sent += JSON.stringify({ kind, id: data.id, data }).length;
      return sent;
    });
  if (want("snapshot"))
    await step("Page fallback: whole state in one answer", async () => {
      const events = store.loadEvents(300);
      const res = jsonStream(snapshotText(eng.publicSnapshot() as Record<string, unknown[]>, events));
      let bytes = 0;
      const got = createHash("sha256");
      const reader = res.body!.getReader();
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        bytes += r.value.byteLength;
        got.update(r.value);
        sample();
      }
      sent = { bytes, sha: got.digest("hex"), events };
      console.log(`  The answer is ${bytes.toLocaleString("en-US")} bytes.`);
    });
  // Outside the measurement: the answer sent in pieces must be, byte for byte, the answer the unchanged code gives.
  if (sent && want("same")) {
    const whole = Buffer.from(JSON.stringify({ entities: eng.publicSnapshot(), events: sent.events }));
    same("The page's answer", whole.byteLength === sent.bytes && createHash("sha256").update(whole).digest("hex") === sent.sha);
  }
  if (want("transcripts"))
    await step("Reading every task's conversation, one at a time", () => {
      let n = 0;
      for (const t of eng.all("task")) {
        n += eng.transcript(t.id)?.msgs.length ?? 0;
        sample();
      }
      console.log(`  ${n.toLocaleString("en-US")} messages.`);
    });

  // 4. What the engine does by itself while it works: a checkpoint at the end of each cycle, then copying it to the store.
  if (want("checkpoint")) {
    let ck = "";
    await step("Saving a checkpoint (end of a cycle)", () => {
      checkpoint(eng, "memory rehearsal");
      eng.flush();
      ck = eng.all("checkpoint").sort((a, b) => b.at - a.at)[0]?.id ?? "";
    });
    await step("Preparing that checkpoint for the store", async () => {
      const parts = await encodeFrom(store.textParts(`ckpt:${ck}`));
      if (!parts) throw new Error("The checkpoint was not kept.");
      console.log(`  ${parts.length} pieces, ${parts.reduce((n, p) => n + p.length, 0).toLocaleString("en-US")} characters packed.`);
    });
    if (want("same")) {
      // The checkpoint written record by record must be the text the unchanged code writes, and hold what the engine holds.
      const text = store.getText(`ckpt:${ck}`) ?? "";
      const back = JSON.parse(text) as {
        checkpointId: string;
        entities: Record<string, unknown[]>;
      };
      let ok = JSON.stringify(back) === text && back.checkpointId === ck;
      for (const [kind, list] of Object.entries(back.entities)) if (JSON.stringify(list) !== JSON.stringify(eng.all(kind as never))) ok = false;
      same(`Checkpoint ${ck} (${text.length.toLocaleString("en-US")} characters)`, ok);
    }
  }
  if (want("same")) {
    // Every long text, packed for the store a part at a time, must come out as the very same pieces as packed whole.
    let n = 0;
    let bad = 0;
    for (const r of store.sql("SELECT DISTINCT ref FROM txt")) {
      const ref = String(r.ref);
      const whole = store.unit("txt", ref);
      const a = whole === null ? null : await encode(whole);
      const b = await encodeFrom(store.textParts(ref));
      n++;
      if (!a || !b || a.length !== b.length || a.some((p, i) => p !== b[i])) bad++;
    }
    same(`Packing for the store, ${n} long texts`, bad === 0);
  }
  // 5. What the owner can ask for on the Records page: a checkpoint handed over whole (GET /internal/checkpoints/:id),
  //    which is also the first half of "Branch"; then the new project built from it.
  if (want("ckdown")) {
    let ck = read("MEM_CKPT");
    let size = 0;
    for (const c of eng.all("checkpoint")) {
      let n = 0;
      for (const p of store.textParts(`ckpt:${c.id}`)) n += p.length;
      console.log(`  Checkpoint ${c.id}: ${n.toLocaleString("en-US")} characters.`);
      if (read("MEM_CKPT") ? c.id === ck : n > size) {
        ck = c.id;
        size = n;
      }
    }
    for (const f of readdirSync(dir)) if (f.startsWith(`scholium-rehearsal-${id}.checkpoint-`)) rmSync(join(dir, f));
    const file = join(dir, `scholium-rehearsal-${id}.checkpoint-${ck}.json`);
    await step(`Checkpoint ${ck}: handing it over whole`, async () => {
      const cp = eng.exportCheckpoint(ck);
      if (!cp) throw new Error("The checkpoint could not be read.");
      sample();
      const res = json(cp);
      sample();
      const fd = openSync(file, "w");
      let bytes = 0;
      const reader = res.body!.getReader();
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        bytes += r.value.byteLength;
        writeSync(fd, r.value);
        sample();
      }
      closeSync(fd);
      console.log(`  The answer is ${bytes.toLocaleString("en-US")} bytes.`);
    });
    console.log(`  Of the highest seen, outside the JavaScript heap: ${mb(topOutside)}.`);
  }
  if (want("branch")) {
    const h = handedOver();
    if (!h) throw new Error("Run with MEM_STEPS=ckdown first.");
    await branch(store, id, h.ck, h.file);
  }
  // What a running project does by itself right after it is opened: the background pass (Drive copy, digest e-mail).
  // Nothing is sent anywhere: only the texts those jobs would build are built and measured.
  if (want("work")) {
    const r = eng.run;
    const tasks = eng.all("task");
    const count = (s: string): number => tasks.filter((t) => t.status === s).length;
    const newest = Math.max(0, ...eng.all("checkpoint").map((c) => c.at));
    const iso = (n?: number): string => (n ? new Date(n).toISOString() : "never");
    console.log(`  Drive copy: ${r.config.drive ? "on" : "off"}, last ${iso(r.driveLastSyncAt)}, more waiting ${r.counters.driveMore ?? 0}, newest checkpoint ${iso(newest)}, error ${r.driveError ? "yes" : "no"}.`);
    console.log(`  Digest e-mail: ${r.config.alerts.enabled ? "on" : "off"}, next ${iso(r.nextDigestAt)}. Tasks: ${count("running")} running, ${count("queued")} queued, ${count("waiting")} waiting.`);
    // What the pass built before it was changed (all three at once, in the site): asked for by name, since it does not fit.
    if (only.has("driveold")) {
      let md = "";
      await step("Drive copy: the full report", () => {
        md = buildReport(dataFrom(eng.snapshot()), {
          now: Date.now(),
          full: true,
        });
        return md.length;
      });
      console.log(`  The report is ${md.length.toLocaleString("en-US")} characters.`);
      await step("Drive copy: the report as LaTeX", () => toLatex(md, r.config.title || "x").length);
      md = "";
      await step("Drive copy: the ledger", () => eng.export("json").content.length);
    }
    // The pass as the site now runs it: one file's text at a time, hashed and encoded as an upload would be.
    await step("Drive copy: a whole pass, as now built", async () => {
      const { files, slim } = driveFiles(eng);
      let chars = 0;
      let largest = 0;
      for (const f of files) {
        const before = used();
        const content = f.make();
        if (content === null) continue;
        sample();
        createHash("sha256").update(content).digest("hex");
        const body = new TextEncoder().encode(content);
        chars += content.length;
        largest = Math.max(largest, body.byteLength);
        sample();
        if (content.length > 1_000_000) console.log(`  ${f.name}: ${content.length.toLocaleString("en-US")} characters, ${mb(used() - before)} more in use once built.`);
      }
      console.log(`  ${files.length.toLocaleString("en-US")} files, ${chars.toLocaleString("en-US")} characters, largest ${mb(largest)}; reduced for size: ${slim ? "yes" : "no"}.`);
    });
    await step("Digest e-mail text", () => JSON.stringify(buildDigest(dataFrom(eng.snapshot()), "digest", Date.now())).length);
    await step("Summary for the workspace", () => JSON.stringify(eng.summary()).length);
  }
  if (want("backup")) await step("Download: backup file", () => JSON.stringify(buildBackup(eng)).length);
  if (want("export")) await step("Download: export as JSON", () => eng.export("json").content.length);
}
console.log("\nDone.");
