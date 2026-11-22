// Runs one scripted investigation end to end and prints what the engine did. Run: bun scripts/explore.ts
import { cooperative, makeHarness } from "../src/engine/testkit";

const h = makeHarness({ config: { mode: process.argv[2] ?? "collaborative" } });
h.llm.script = cooperative(h, { delegate: Number(process.argv[3] ?? 0) });
const res = await h.eng.action("start");
console.log("start:", res);
const ticks = await h.drain({ max: 300 });
const r = h.eng.run;
console.log(`ticks ${ticks} status ${r.status} phase ${r.phase} cycle ${r.cycle} goal ${r.goalReached} ${r.goalClaimId} spend ${r.spend.usd.toFixed(3)} calls ${r.spend.calls} outcome ${r.outcome}`);
for (const e of h.store.events) console.log(`  [${e.level}] ${e.type}: ${e.text.slice(0, 230)}`);
for (const c of h.eng.all("claim")) console.log(`claim ${c.id} ${c.label} (${c.proposedLabel}) ${c.status} blockers=${JSON.stringify(c.blockers)}`);
for (const t of h.eng.all("task")) console.log(`task ${t.id} ${t.type} ${t.agentId} ${t.status} turns ${t.turns} ${t.error ?? ""}`);
console.log("subagents", r.subagents, "reserved", r.spend.reservedUsd);
