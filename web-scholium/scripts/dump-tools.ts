// Prints every tool the engine offers, per task type, with its parameter names. Run: bun scripts/dump-tools.ts
import { toolsFor, SAVE_PROGRESS } from "../src/engine/tools";
import { makeHarness } from "../src/engine/testkit";
import type { TaskType } from "../src/shared/types";

const h = makeHarness();
const eng = h.eng;
eng.run.status = "running";
eng.run.cycle = 1;
eng.run.toolStatus = { web: { ok: true, detail: "", checkedAt: 0 }, literature: { ok: true, detail: "", checkedAt: 0 }, oeis: { ok: true, detail: "", checkedAt: 0 } };
const lead = eng.activeLeads()[0];
const seen = new Map<string, string>();
const types: TaskType[] = ["understand", "prior_work", "work", "cross_review", "revise", "confirm", "decide", "report"];
const fmt = (p: Record<string, unknown>): string => {
  const props = (p.properties ?? {}) as Record<string, Record<string, unknown>>;
  const req = new Set((p.required as string[] | undefined) ?? []);
  return Object.entries(props)
    .map(([k, v]) => {
      const t = v.enum ? (v.enum as string[]).join("|") : v.type === "array" ? `${((v.items as Record<string, unknown>)?.type as string) ?? "obj"}[]` : String(v.type);
      const inner = v.type === "array" && (v.items as Record<string, unknown>)?.type === "object" ? `{${fmt(v.items as Record<string, unknown>)}}` : "";
      return `${k}${req.has(k) ? "*" : ""}:${t}${inner}`;
    })
    .join(", ");
};
for (const type of types) {
  eng.run.phase = type;
  const task = eng.newLeadTask(type, lead);
  if (type === "work") {
    console.log(`work (before commit): ${toolsFor(eng, task, lead).map((t) => t.def.name).join(" ")}`);
    eng.run.approachCommitted[lead.id] = eng.run.cycle;
  }
  const tools = toolsFor(eng, task, lead);
  console.log(`${type}: ${tools.map((t) => t.def.name).join(" ")}`);
  for (const t of tools) seen.set(t.def.name, fmt(t.def.parameters));
}
const { created } = eng.spawn(lead, [{ question: "Check the cases n ≤ 40 by direct computation and list any failures.", role: "Computation", context: "", sources: [], expectedOutput: "A table", completionCriteria: "All cases covered", dependsOn: [], maxTurns: 10, budgetUsd: 1 }]);
const sub = created[0];
const st = eng.taskOf(sub.id)!;
const stools = toolsFor(eng, st, sub);
console.log(`subagent: ${stools.map((t) => t.def.name).join(" ")}`);
for (const t of stools) seen.set(t.def.name, fmt(t.def.parameters));
seen.set(SAVE_PROGRESS.def.name, fmt(SAVE_PROGRESS.def.parameters));
console.log("");
for (const [k, v] of seen) console.log(`${k}(${v})`);
