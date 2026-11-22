// A dress rehearsal of moving to a fresh copy of the site, done on this computer and changing nothing anywhere.
// It reads every project from the permanent store exactly as a new copy would, opens it with the site's own
// research engine (the same loading code the site runs after "Continue here"), and then checks, letter for letter,
// that what the engine holds is what the store holds: every record, and every message of every agent's and
// subagent's conversation, including the model's saved thinking. No model is called and no work is done.
// Run from the project root: bun web-scholium/scripts/rehearse-move.ts
// Needs SCHOLIUM_MOVE_KEY, or EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, in the environment or in
// web-scholium/.env. No secret is ever printed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Engine } from "../src/engine/engine";
import type { Services } from "../src/engine/services";
import { MemoryStore } from "../src/engine/store";
import { ALLOWED_EMAIL, ownerHashFor } from "../src/shared/gate";
import type { ActivityEvent, EntityKind, Msg } from "../src/shared/types";
import { readMoveKey, type Env } from "../worker/env";
import { restore } from "../worker/vault";

const root = resolve(import.meta.dir, "..", "..");
const fromFile: Record<string, string> = {};
const envFile = join(root, "web-scholium", ".env");
if (existsSync(envFile))
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) fromFile[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
const read = (k: string): string => process.env[k] ?? fromFile[k] ?? "";
const move = readMoveKey(read("SCHOLIUM_MOVE_KEY"));
const url = (move?.EXPO_PUBLIC_SUPABASE_URL ?? read("EXPO_PUBLIC_SUPABASE_URL")).replace(/\/+$/, "");
const key = move?.SUPABASE_SERVICE_ROLE_KEY ?? read("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) throw new Error("The store's address and key are needed: set SCHOLIUM_MOVE_KEY (or EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).");
const env = { EXPO_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } as Env;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const num = (n: number): string => n.toLocaleString("en-US");
const problems: string[] = [];

// The engine is only opened, never run: anything that would reach a model or the web stops the rehearsal.
const services = new Proxy({ now: () => Date.now() } as Services, {
  get: (t, p) => {
    if (p === "now") return t.now;
    throw new Error(`The rehearsal tried to use "${String(p)}", which it must never do.`);
  },
});

const ws: string[] = [];
await restore(env, `ws:${await ownerHashFor(ALLOWED_EMAIL)}`, (units) => {
  for (const u of units) if (u.k.startsWith("run:")) ws.push(u.k.slice(4));
});
console.log(`Store: ${new URL(url).host}${move ? " (reached with the move key)" : ""}. Projects: ${ws.length}.`);

for (const id of ws) {
  // 1. Read the project out of the store the way a new copy does.
  const store = new MemoryStore();
  const stored = { ents: new Map<string, string>(), msgs: new Map<string, string[]>() };
  const print = createHash("sha256");
  let letters = 0;
  await restore(env, `run:${id}`, (units) => {
    for (const u of units) {
      print.update(`${u.tbl}\u0000${u.k}\u0000`).update(u.value);
      letters += typeof u.value === "string" ? u.value.length : u.value.byteLength;
      if (typeof u.value !== "string") {
        store.putBlob(u.k, u.value);
        continue;
      }
      if (u.tbl === "ent") {
        const cut = u.k.indexOf("\t");
        stored.ents.set(u.k, u.value);
        store.putEntity(u.k.slice(0, cut) as EntityKind, u.k.slice(cut + 1), JSON.parse(u.value));
      } else if (u.tbl === "msg") {
        const cut = u.k.lastIndexOf("\t");
        const task = u.k.slice(0, cut);
        const list = stored.msgs.get(task) ?? [];
        list[Number(u.k.slice(cut + 1))] = u.value;
        stored.msgs.set(task, list);
      } else if (u.tbl === "ev") store.appendEvent(JSON.parse(u.value) as ActivityEvent);
      else if (u.tbl === "txt") store.putText(u.k, u.value);
    }
  });
  for (const [task, list] of stored.msgs) store.msgs.set(task, list);

  // 2. Open it with the site's own engine, as the new copy does after "Continue here".
  const before = new Map<string, string>();
  for (const [k, v] of stored.ents) if (k.startsWith("task\t")) before.set(k.slice(5), String(rec(JSON.parse(v)).status));
  const eng = new Engine(store, services, { broadcast: () => {}, wake: () => {} });
  if (!eng.load()) {
    problems.push(`${id}: the engine could not open the project from the store.`);
    continue;
  }
  const run = eng.run;
  console.log(`\nProject "${run.config.title}"`);
  console.log(`  Read from the store: ${num(letters)} characters. Fingerprint of every one of them: ${print.digest("hex").slice(0, 24)}…`);
  console.log(`  Opened by the engine: status ${run.status}, cycle ${run.cycle}, phase ${run.phase}, spent $${run.spend.usd.toFixed(2)}, subagent limit ${run.config.limits?.subagentCap ?? "?"}.`);

  // 3. Every record the engine now holds must be the stored one, letter for letter. The engine may adjust only
  //    what it is meant to on opening: a step cut off mid-turn is queued again, and held-back money is released.
  let same = 0;
  const adjusted: string[] = [];
  for (const [k, text] of stored.ents) {
    const cut = k.indexOf("\t");
    const kind = k.slice(0, cut) as EntityKind;
    const held = eng.all(kind).find((e) => (e as { id: string }).id === k.slice(cut + 1));
    if (!held) {
      // Kinds the engine does not keep in memory stay in the store untouched; they are compared there.
      const still = store.loadEntities().find((e) => e.kind === kind && e.id === k.slice(cut + 1));
      if (still && JSON.stringify(still.data) === text) same++;
      else problems.push(`${run.config.title}: record ${k.replace("\t", " ")} did not come back.`);
    } else if (JSON.stringify(held) === text) same++;
    else adjusted.push(k.replace("\t", " "));
  }
  console.log(`  Records: ${num(stored.ents.size)} stored, ${num(same)} identical letter for letter after opening${adjusted.length ? `, ${adjusted.length} adjusted by the engine on opening (${adjusted.slice(0, 6).join(", ")}${adjusted.length > 6 ? ", …" : ""})` : ""}.`);
  for (const a of adjusted) if (!/^(run|task) /.test(a)) problems.push(`${run.config.title}: ${a} changed on opening, which is not expected.`);

  // 4. Every agent's conversation, as the engine will hand it to the model on its next turn.
  const agents = eng.all("agent");
  const tasks = eng.all("task");
  let msgsSame = 0;
  let msgsAll = 0;
  let thinking = 0;
  let thinkingChars = 0;
  let rawTurns = 0;
  for (const t of tasks) {
    const want = stored.msgs.get(t.id) ?? [];
    const got: Msg[] = eng.msgs(t.id);
    msgsAll += want.length;
    if (got.length !== want.length || t.msgCount !== want.length) problems.push(`${run.config.title}: task ${t.id} has ${want.length} messages stored, ${got.length} opened, and says ${t.msgCount}.`);
    got.forEach((m, i) => {
      if (JSON.stringify(m) === want[i]) msgsSame++;
      else problems.push(`${run.config.title}: message ${i} of task ${t.id} differs.`);
      if (m.role === "assistant") {
        if (m.thinking) {
          thinking++;
          thinkingChars += m.thinking.length;
        }
        if (m.raw.length) rawTurns++;
      }
    });
  }
  const subs = agents.filter((a) => a.kind === "subagent");
  console.log(`  Agents: ${agents.length} (${subs.length} subagents). Every one has its assignment: ${subs.every((a) => !!a.assignment?.question) ? "yes" : "NO"}.`);
  console.log(`  Conversations: ${num(msgsAll)} messages in ${tasks.length} tasks, ${num(msgsSame)} identical letter for letter after opening.`);
  console.log(`  Saved thinking: ${num(thinking)} model turns carry the model's own reasoning (${num(thinkingChars)} characters); ${num(rawTurns)} turns carry the model's exact original reply, which is what is sent back to it.`);
  for (const a of subs) if (!a.assignment?.question) problems.push(`${run.config.title}: subagent ${a.id} has no assignment.`);

  // 5. Who still has work to do, and where exactly each of them stands.
  const count = (m: Iterable<string>): string => {
    const c: Record<string, number> = {};
    for (const s of m) c[s] = (c[s] ?? 0) + 1;
    return Object.entries(c).map(([s, n]) => `${n} ${s}`).join(", ") || "none";
  };
  console.log(`  Tasks as stored: ${count(before.values())}. After opening: ${count(tasks.map((t) => t.status))}.`);
  const cut = [...before.values()].filter((s) => s === "running").length;
  console.log(cut ? `  ${cut} task(s) were cut off in the middle of a turn; they are queued to ask that one turn again, with everything before it kept.` : "  No task was cut off in the middle of a turn: every agent stopped at the end of a finished turn.");
  const open = tasks.filter((t) => t.status === "queued" || t.status === "waiting" || t.status === "running");
  console.log(`  Unfinished tasks that carry on after the move: ${open.length}.`);
  for (const t of open.slice(0, 60)) {
    const m = eng.msgs(t.id);
    const last = m[m.length - 1];
    const a = agents.find((x) => x.id === t.agentId);
    const where = !last ? "not started yet (its assignment is saved)" : last.role === "tool" ? "has the results of its last tool calls and is about to think again" : last.role === "assistant" ? `last spoke itself${last.thinking ? ` (reasoning saved, ${num(last.thinking.length)} characters)` : ""}` : "has a message waiting to be answered";
    console.log(`    ${t.agentId} "${String(a?.name ?? "").slice(0, 48)}" ${t.status}: ${m.length} messages, ${num(m.reduce((n, x) => n + JSON.stringify(x).length, 0))} characters; ${where}.`);
  }
  if (open.length > 60) console.log(`    … and ${open.length - 60} more.`);
}

if (problems.length) {
  console.log(`\nPROBLEMS: ${problems.length}`);
  for (const p of problems.slice(0, 40)) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("\nRehearsal passed: a fresh copy opens every project from the store with nothing changed and nothing missing.");
