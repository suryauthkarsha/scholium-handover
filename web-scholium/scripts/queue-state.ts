// Shows why queued owner instructions have or have not reached the leads: the project's state, every instruction that is
// still queued, each lead with its unfinished tasks, and the newest lines of the activity log.
// It only reads the permanent store; nothing in the store or on any site is changed. Run from the project root:
//   rork env run -e production -- bun web-scholium/scripts/queue-state.ts
// Needs SCHOLIUM_MOVE_KEY in the environment. No secret is ever printed.
import { ALLOWED_EMAIL, ownerHashFor } from "../src/shared/gate";
import { readMoveKey, type Env } from "../worker/env";
import { restore } from "../worker/vault";

const move = readMoveKey(process.env.SCHOLIUM_MOVE_KEY);
if (!move?.EXPO_PUBLIC_SUPABASE_URL || !move.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Set SCHOLIUM_MOVE_KEY.");
const env = { EXPO_PUBLIC_SUPABASE_URL: move.EXPO_PUBLIC_SUPABASE_URL.replace(/\/+$/, ""), SUPABASE_SERVICE_ROLE_KEY: move.SUPABASE_SERVICE_ROLE_KEY } as Env;

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
const at = (n: unknown): string => (typeof n === "number" && n > 0 ? new Date(n).toISOString().slice(5, 19).replace("T", " ") : "-");
const short = (s: unknown, n = 200): string => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const DONE = new Set(["done", "failed", "cancelled"]);

const owner = await ownerHashFor(ALLOWED_EMAIL);
const runIds: string[] = [];
await restore(env, `ws:${owner}`, (units) => {
  for (const u of units) if (u.k.startsWith("run:")) runIds.push(u.k.slice(4));
});

for (const id of runIds) {
  let run: Rec = {};
  const agents = new Map<string, Rec>();
  const tasks: Rec[] = [];
  const instructions: Rec[] = [];
  const events: { n: number; e: Rec }[] = [];
  await restore(env, `run:${id}`, (page) => {
    for (const u of page) {
      if (typeof u.value !== "string") continue;
      if (u.tbl === "ev") {
        events.push({ n: Number(u.k), e: parse(u.value) });
        if (events.length > 400) events.splice(0, 200);
        continue;
      }
      if (u.tbl !== "ent") continue;
      const kind = u.k.slice(0, u.k.indexOf("\t"));
      if (kind === "run") run = parse(u.value);
      else if (kind === "agent") {
        const a = parse(u.value);
        agents.set(String(a.id), { id: a.id, kind: a.kind, name: a.name, status: a.status, active: a.active, model: a.model });
      } else if (kind === "task") {
        const t = parse(u.value);
        tasks.push({ id: t.id, type: t.type, agentId: t.agentId, status: t.status, cycle: t.cycle, notBefore: t.notBefore, error: t.error, attempts: t.attempts, waiting: rec(t.waiting).agentIds, msgCount: t.msgCount, updatedAt: t.updatedAt, startedAt: t.startedAt });
      } else if (kind === "instruction") instructions.push(parse(u.value));
    }
  });
  const now = Date.now();
  console.log(`Project ${id.slice(0, 8)}…, read at ${at(now)} UTC`);
  console.log(`  Status ${String(run.status)}, phase ${String(run.phase)}, cycle ${String(run.cycle)}. Pause reason: ${short(run.pauseReason) || "none"}. Needs attention: ${short(run.attention) || "no"}.`);
  const fields = Object.keys(run).filter((k) => !["config", "counters", "toolStatus", "spend"].includes(k));
  console.log(`  Run fields: ${fields.map((k) => `${k}=${short(typeof run[k] === "object" ? JSON.stringify(run[k]) : run[k], 60)}`).join("; ")}`);
  console.log(`  Limits: ${short(JSON.stringify(rec(run.config).limits), 400)}`);
  console.log(`  Tool status: ${Object.entries(rec(run.toolStatus)).map(([k, v]) => `${k}=${rec(v).ok ? "ok" : `OFF (${short(rec(v).detail, 80)})`}`).join(", ")}`);

  const byStatus: Record<string, number> = {};
  for (const t of tasks) byStatus[String(t.status)] = (byStatus[String(t.status)] ?? 0) + 1;
  console.log(`  Tasks: ${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(", ")}.`);

  console.log("\n  Leads and their unfinished tasks:");
  for (const a of agents.values()) {
    if (a.kind !== "lead") continue;
    console.log(`    ${String(a.id)} ${String(a.name)} [${String(a.model)}] status ${String(a.status)}, active ${String(a.active)}`);
    const mine = tasks.filter((t) => t.agentId === a.id);
    for (const t of mine.filter((t) => !DONE.has(String(t.status))))
      console.log(`      ${String(t.id)} ${String(t.type)} cycle ${String(t.cycle)}: ${String(t.status)}, ${String(t.msgCount)} messages, attempts ${String(t.attempts ?? 0)}, not before ${at(t.notBefore)}, waits for ${Array.isArray(t.waiting) ? `${t.waiting.length} subagent(s)` : "nothing"}, error: ${short(t.error, 160) || "none"}`);
    const last = mine.filter((t) => DONE.has(String(t.status))).sort((x, y) => Number(String(y.id).replace(/\D+/g, "")) - Number(String(x.id).replace(/\D+/g, "")))[0];
    if (last) console.log(`      last finished: ${String(last.id)} ${String(last.type)} cycle ${String(last.cycle)} ${String(last.status)}${last.error ? `, error: ${short(last.error, 160)}` : ""}`);
  }
  const subs = [...agents.values()].filter((a) => a.kind === "subagent");
  const subBy: Record<string, number> = {};
  for (const a of subs) subBy[String(a.status)] = (subBy[String(a.status)] ?? 0) + 1;
  console.log(`  Subagents: ${Object.entries(subBy).map(([k, v]) => `${v} ${k}`).join(", ")}.`);
  const live = tasks.filter((t) => !DONE.has(String(t.status)) && agents.get(String(t.agentId))?.kind !== "lead");
  for (const t of live.slice(0, 25)) console.log(`      ${String(t.id)} ${String(t.type)} (${String(agents.get(String(t.agentId))?.model)}): ${String(t.status)}, ${String(t.msgCount)} messages, attempts ${String(t.attempts ?? 0)}, not before ${at(t.notBefore)}, error: ${short(t.error, 140) || "none"}`);

  const queued = instructions.filter((i) => i.status === "queued").sort((a, b) => Number(a.order) - Number(b.order));
  console.log(`\n  Instructions: ${instructions.length} in all, ${queued.length} still queued.`);
  for (const i of queued) {
    const d = (Array.isArray(i.deliveries) ? i.deliveries : []).map((x) => `${String(rec(x).agentId)} at ${at(rec(x).at)}`);
    console.log(`    ${String(i.id)} for ${String(i.target)}, sent ${at(i.createdAt)}, ${String(i.text ?? "").length} characters. Reached: ${d.join(", ") || "nobody yet"}.`);
  }

  console.log("\n  Newest activity:");
  for (const { n, e } of events.sort((a, b) => a.n - b.n).slice(-45)) console.log(`    ${n} ${at(e.at)} ${String(e.level ?? "")} ${String(e.kind ?? e.type ?? "")}: ${short(e.text ?? e.message, 230)}`);
}
