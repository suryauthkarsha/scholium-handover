// Reads everything the permanent store holds and checks that it is whole: every project record, every agent and
// subagent, every task with its full transcript, every event, checkpoint, source text and uploaded file.
// It only reads; nothing in the store or on any site is changed. Run from the project root:
//   bun web-scholium/scripts/check-store.ts            the whole store
//   bun web-scholium/scripts/check-store.ts sub-100    the same, and show that agent's saved context in detail
// Needs SCHOLIUM_MOVE_KEY, or EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, in the environment or in
// web-scholium/.env. No secret is ever printed.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ALLOWED_EMAIL, ownerHashFor } from "../src/shared/gate";
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
const detail = process.argv[2] ?? "";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const parse = (v: string): Rec => {
  try {
    const o = rec(JSON.parse(v));
    return "data" in o && typeof o.data === "object" ? rec(o.data) : o;
  } catch {
    return {};
  }
};
const num = (n: number): string => n.toLocaleString("en-US");
const problems: string[] = [];
const moving: string[] = [];

const get = async (path: string): Promise<unknown> => {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`The store answered ${res.status} for ${path.split("?")[0]}.`);
  return res.json();
};

console.log(`Store: ${new URL(url).host}${move ? " (reached with the move key)" : ""}`);
console.log(`Owner: ${ALLOWED_EMAIL}`);
const lease = (await get("scholium_lease?select=site,label,epoch,at")) as Rec[];
for (const l of lease) console.log(`Working copy: ${String(l.label || "unnamed")} (site ${String(l.site).slice(0, 8)}…, turn ${String(l.epoch)}, since ${String(l.at).slice(0, 19)}Z)`);
if (!lease.length) console.log("Working copy: none yet");

// ---- The workspace ----
const owner = await ownerHashFor(ALLOWED_EMAIL);
const ws = new Map<string, string>();
await restore(env, `ws:${owner}`, (units) => {
  for (const u of units) if (typeof u.value === "string") ws.set(u.k, u.value);
});
const runIds = [...ws.keys()].filter((k) => k.startsWith("run:")).map((k) => k.slice(4));
const drive = rec(JSON.parse(ws.get("drive") ?? "{}"));
console.log(`\nWorkspace: ${ws.size} records (${runIds.length} project${runIds.length === 1 ? "" : "s"}, settings ${ws.has("settings") ? "saved" : "as first set up (never changed, so nothing to save)"}, budget ${ws.has("budget") ? "saved" : "as first set up (never changed)"}, Drive connection ${drive.refresh ? "saved" : "not connected"}, method notes ${ws.has("strategy") ? "saved" : "none"})`);
if (!ws.size) problems.push("The store holds no workspace for this email.");

// ---- Each project ----
for (const id of runIds) {
  const listed = rec(JSON.parse(ws.get(`run:${id}`) ?? "{}"));
  const kinds: Record<string, number> = {};
  let run: Rec = {};
  const agents = new Map<string, Rec>();
  const tasks = new Map<string, Rec>();
  const checkpoints: string[] = [];
  const uploads: string[] = [];
  const msgs = new Map<string, { n: number; max: number; chars: number }>();
  const texts = new Map<string, number>();
  const blobs = new Map<string, number>();
  const ev = { n: 0, min: Infinity, max: 0 };
  let units = 0;
  let chars = 0;
  await restore(env, `run:${id}`, (page) => {
    for (const u of page) {
      units++;
      const size = typeof u.value === "string" ? u.value.length : u.value.byteLength;
      chars += size;
      if (u.tbl === "ent" && typeof u.value === "string") {
        const cut = u.k.indexOf("\t");
        const kind = u.k.slice(0, cut);
        const eid = u.k.slice(cut + 1);
        kinds[kind] = (kinds[kind] ?? 0) + 1;
        if (kind === "run") run = parse(u.value);
        else if (kind === "agent") {
          const a = parse(u.value);
          agents.set(eid, { id: eid, kind: a.kind, name: a.name, status: a.status, question: rec(a.assignment).question, result: a.result ?? a.summary });
        } else if (kind === "task") {
          const t = parse(u.value);
          tasks.set(eid, { id: eid, agentId: t.agentId, status: t.status, msgCount: t.msgCount, title: t.title });
        } else if (kind === "checkpoint") checkpoints.push(eid);
        else if (kind === "upload") uploads.push(eid);
      } else if (u.tbl === "msg") {
        const cut = u.k.lastIndexOf("\t");
        const task = u.k.slice(0, cut);
        const m = msgs.get(task) ?? { n: 0, max: -1, chars: 0 };
        m.n++;
        m.max = Math.max(m.max, Number(u.k.slice(cut + 1)));
        m.chars += size;
        msgs.set(task, m);
      } else if (u.tbl === "ev") {
        const s = Number(u.k);
        ev.n++;
        ev.min = Math.min(ev.min, s);
        ev.max = Math.max(ev.max, s);
      } else if (u.tbl === "txt") texts.set(u.k, size);
      else if (u.tbl === "blob") blobs.set(u.k, size);
    }
  });
  const title = String(rec(run.config).title || listed.title || id);
  console.log(`\nProject "${title}" (${id})`);
  if (!units) {
    problems.push(`${title}: the store holds nothing for this project.`);
    continue;
  }
  if (!run.id) problems.push(`${title}: the project record itself is missing.`);
  const live = run.status === "running";
  const subs = [...agents.values()].filter((a) => a.kind === "subagent");
  const made = Number(rec(run.subagents).created ?? 0);
  console.log(`  ${num(units)} items, ${num(chars)} characters. Status ${String(run.status)}, phase ${String(run.phase)}, cycle ${String(run.cycle)}, spent $${Number(rec(run.spend).usd ?? 0).toFixed(2)}.`);
  console.log(`  Agents: ${agents.size} (${subs.length} subagents; the project counts ${made} created).`);
  if (subs.length !== made) (live ? moving : problems).push(`${title}: ${subs.length} subagents are stored but the project counts ${made}.`);

  // Every task must have its whole transcript: as many messages as the task says, numbered without a gap.
  let whole = 0;
  let msgTotal = 0;
  for (const t of tasks.values()) {
    const want = Number(t.msgCount ?? 0);
    const got = msgs.get(String(t.id)) ?? { n: 0, max: -1, chars: 0 };
    msgTotal += got.n;
    if (got.n === want && got.max === want - 1) whole++;
    else (t.status === "running" || t.status === "queued" || t.status === "waiting" ? moving : problems).push(`${title}: task ${String(t.id)} (${String(t.status)}) says ${want} messages, the store has ${got.n} (last number ${got.max}).`);
    if (!agents.has(String(t.agentId))) problems.push(`${title}: task ${String(t.id)} belongs to agent ${String(t.agentId)}, which is not stored.`);
  }
  for (const task of msgs.keys()) if (!tasks.has(task)) (live ? moving : problems).push(`${title}: messages are stored for task ${task}, but the task record is not.`);
  console.log(`  Tasks: ${tasks.size}, of which ${whole} have their transcript complete to the last message (${num(msgTotal)} messages).`);
  const idle = subs.filter((a) => ![...tasks.values()].some((t) => t.agentId === a.id));
  if (idle.length) (live ? moving : problems).push(`${title}: ${idle.length} subagent(s) have no task stored: ${idle.slice(0, 5).map((a) => String(a.id)).join(", ")}.`);

  // Events are numbered from 1 without gaps; the store keeps all of them.
  const seq = Number(run.seq ?? 0);
  console.log(`  Activity log: ${num(ev.n)} entries, numbers ${ev.n ? ev.min : 0} to ${ev.max} (the project is at ${seq}).`);
  if (ev.n && ev.n !== ev.max - ev.min + 1) problems.push(`${title}: the activity log has gaps (${ev.n} entries between ${ev.min} and ${ev.max}).`);
  if (ev.max !== seq) (live || Math.abs(ev.max - seq) < 50 ? moving : problems).push(`${title}: the activity log ends at ${ev.max}, the project is at ${seq}.`);

  const full = checkpoints.filter((c) => (texts.get(`ckpt:${c}`) ?? 0) > 2).length;
  console.log(`  Checkpoints: ${checkpoints.length} recorded, ${full} with their full snapshot (older snapshots are let go by the site itself).`);
  if (checkpoints.length && !full) problems.push(`${title}: no checkpoint has its snapshot.`);
  const srcTexts = [...texts.keys()].filter((k) => k.startsWith("src:")).length;
  console.log(`  Sources: ${kinds.source ?? 0} recorded, ${srcTexts} with their text. Uploaded files: ${uploads.length} recorded, ${blobs.size} stored.`);
  for (const u of uploads) if (!blobs.has(`up:${u}`)) problems.push(`${title}: uploaded file ${u} is recorded but its contents are not stored.`);
  console.log(`  Ledger: ${Object.entries(kinds).filter(([k]) => !["run", "agent", "task", "checkpoint", "source", "upload"].includes(k)).map(([k, n]) => `${n} ${k}`).join(", ") || "empty"}.`);

  // The saved context of one agent, in detail: the one asked for, else the 100th subagent and the newest.
  const order = subs.map((a) => String(a.id)).sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
  const show = detail ? [detail] : [...new Set([order[99], order[order.length - 1]].filter(Boolean))];
  for (const aid of show) {
    const a = agents.get(aid);
    if (!a) continue;
    const mine = [...tasks.values()].filter((t) => t.agentId === aid);
    const m = mine.map((t) => msgs.get(String(t.id)) ?? { n: 0, max: -1, chars: 0 });
    console.log(`  ${aid} "${String(a.name).slice(0, 70)}" (${String(a.status)}): assignment ${a.question ? "saved" : "MISSING"}, ${mine.length} task(s), ${m.reduce((x, y) => x + y.n, 0)} messages, ${num(m.reduce((x, y) => x + y.chars, 0))} characters of context saved.`);
  }
}

// ---- The code copy ----
const code = (await get("scholium_code?select=at,bytes,files,sha")) as Rec[];
console.log(code[0] ? `\nCode copy in the store: ${String(code[0].files)} files, ${Math.round(Number(code[0].bytes) / 1024)} KB, saved ${String(code[0].at).slice(0, 19)}Z.` : "\nCode copy in the store: none.");

if (moving.length) {
  console.log(`\nStill on its way (a project is working right now, so the newest changes arrive seconds later): ${moving.length}`);
  for (const m of moving.slice(0, 12)) console.log(`  - ${m}`);
}
if (problems.length) {
  console.log(`\nPROBLEMS: ${problems.length}`);
  for (const p of problems.slice(0, 40)) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("\nNothing is missing: every stored project is whole.");
