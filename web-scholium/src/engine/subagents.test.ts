// Delegation: the hard cap, the scheduler, and independent review of what subagents return.
import type { SpawnSpec } from "./engine";
import { atPhase, call, cooperative, makeHarness, useTool, type Harness } from "./testkit";

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango"];
/** Assignments that differ enough from one another not to be merged as duplicates. */
function specs(n: number, tag: string, from = 0): SpawnSpec[] {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const a = WORDS[i % 20];
    const b = WORDS[Math.floor(i / 20) % 20];
    return {
      question: `${tag} ${a}${i} ${b}${i} zeta${i} omega${i} sigma${i}: settle case ${i}`,
      role: "Case checker",
      context: "One case of a finite enumeration.",
      sources: [],
      expectedOutput: "A verdict for the case.",
      completionCriteria: "The case is decided.",
      dependsOn: [],
      maxTurns: 8,
      budgetUsd: 1,
    };
  });
}

const lead = (h: Harness, id = "lead-astra62") => {
  const a = h.eng.m.agent.get(id);
  if (!a) throw new Error(`no agent ${id}`);
  return a;
};
const subCount = (h: Harness): number => h.eng.all("agent").filter((a) => a.kind === "subagent").length;

describe("the limit of subagents per run", () => {
  it("is enforced when one request asks for more", () => {
    const h = atPhase(makeHarness(), "work");
    const r = h.eng.spawn(lead(h), specs(1030, "wide"));
    expect(r.created).toHaveLength(1000);
    expect(subCount(h)).toBe(1000);
    expect(r.text).toMatch(/limit of 1000 subagents is reached/);
    expect(h.eng.run.subagents.created).toBe(1000);
    expect(new Set(r.created.map((a) => a.id)).size).toBe(1000);
  });

  it("is shared by all leads and by subagents that delegate further", () => {
    const h = atPhase(makeHarness({ config: { limits: { subagentCap: 100 } } }), "work");
    const a = h.eng.spawn(lead(h, "lead-astra62"), specs(60, "astra"));
    const b = h.eng.spawn(lead(h, "lead-fable52"), specs(30, "fable", 200));
    expect(a.created.length + b.created.length).toBe(90);
    // A first-level subagent may delegate once more; its children count against the same limit.
    const child = h.eng.spawn(a.created[0], specs(25, "nested", 400));
    expect(child.created).toHaveLength(10);
    expect(child.created.every((x) => x.depth === 2 && x.parentId === a.created[0].id)).toBe(true);
    expect(subCount(h)).toBe(100);
    // Second-level subagents cannot delegate at all.
    const deeper = h.eng.spawn(child.created[0], specs(3, "deeper", 600));
    expect(deeper.created).toHaveLength(0);
    expect(deeper.text).toMatch(/depth limit/);
    // Nothing more can be created by anyone, in any order.
    for (const who of ["lead-astra62", "lead-fable52"]) expect(h.eng.spawn(lead(h, who), specs(5, `late-${who}`, 800)).created).toHaveLength(0);
    expect(subCount(h)).toBe(100);
  });

  it("holds when many requests arrive interleaved in the same instant", async () => {
    const h = atPhase(makeHarness({ config: { limits: { subagentCap: 100 } } }), "work");
    const jobs = Array.from({ length: 12 }, (_, i) =>
      Promise.resolve().then(() => h.eng.spawn(lead(h, i % 2 ? "lead-astra62" : "lead-fable52"), specs(15, `burst${i}`, i * 1000)).created.length),
    );
    const made = await Promise.all(jobs);
    expect(made.reduce((x, y) => x + y, 0)).toBe(100);
    expect(subCount(h)).toBe(100);
    const ids = h.eng.all("agent").filter((a) => a.kind === "subagent").map((a) => a.id);
    expect(new Set(ids).size).toBe(100);
  });

  it("survives the engine being reloaded from storage, and counts finished, failed and cancelled subagents", () => {
    const h = atPhase(makeHarness({ config: { limits: { subagentCap: 100 } } }), "work");
    const first = h.eng.spawn(lead(h), specs(97, "before"));
    expect(first.created).toHaveLength(97);
    h.eng.cancelAgent(first.created[0].id, "No longer needed.");
    h.eng.flush();
    const h2 = h.reload();
    expect(subCount(h2)).toBe(97);
    expect(h2.eng.run.subagents.created).toBe(97);
    const more = h2.eng.spawn(lead(h2), specs(10, "after", 300));
    expect(more.created).toHaveLength(3);
    expect(more.created.map((a) => a.id)).toEqual(["sub-98", "sub-99", "sub-100"]);
    h2.eng.flush();
    const h3 = h2.reload();
    expect(h3.eng.spawn(lead(h3), specs(4, "again", 500)).created).toHaveLength(0);
    expect(subCount(h3)).toBe(100);
  });

  it("is respected through the tool the models use, which also limits a single request", async () => {
    const h = atPhase(makeHarness({ config: { limits: { subagentCap: 12 } } }), "work");
    const toArgs = (list: SpawnSpec[]) => list.map((s) => ({ question: s.question, role: s.role, context: s.context, expected_output: s.expectedOutput, completion_criteria: s.completionCriteria }));
    const tooMany = await useTool(h, "lead-astra62", "spawn_subagents", { subagents: toArgs(specs(41, "big")) });
    expect(tooMany.ok).toBe(false);
    expect(subCount(h)).toBe(0);
    const some = await useTool(h, "lead-astra62", "spawn_subagents", { subagents: toArgs(specs(20, "tool")) });
    expect(some.ok).toBe(true);
    expect(subCount(h)).toBe(12);
    expect(some.text).toMatch(/12 of 12/);
    // A lower cap set by the user wins; zero switches delegation off.
    expect(h.eng.updateConfig({ limits: { subagentCap: 0 } }).ok).toBe(true);
    expect((await useTool(h, "lead-fable52", "spawn_subagents", { subagents: toArgs(specs(1, "none", 900)) })).ok).toBe(false);
  });

  it("does not spend the allowance on a question that is already assigned", () => {
    const h = atPhase(makeHarness(), "work");
    const [one] = specs(1, "dup");
    const a = h.eng.spawn(lead(h), [one]);
    const b = h.eng.spawn(lead(h), [{ ...one, question: `${one.question}.` }, ...specs(1, "fresh", 50)]);
    expect(a.created).toHaveLength(1);
    expect(b.created).toHaveLength(1);
    expect(b.text).toMatch(/already has this question/);
    expect(subCount(h)).toBe(2);
  });
});

describe("the scheduler", () => {
  it("never runs more model calls at once than the speed setting allows", async () => {
    for (const [speed, limit] of [["medium", 4], ["fast", 8], ["ultrafast", 16]] as const) {
      const h = makeHarness({ config: { speed } });
      h.llm.script = cooperative(h, { delegate: 14 });
      h.llm.gate = () => new Promise((r) => setTimeout(r, 6));
      await h.eng.action("start");
      // Tick the way the host does: on a timer, without waiting for the calls in flight to finish.
      for (let i = 0; i < 20000 && (h.eng.run.status === "running" || h.eng.inFlight.size); i++) {
        await h.eng.tick();
        await new Promise((r) => setTimeout(r, 1));
        h.svc.clock.t += 40;
      }
      await h.eng.idle();
      expect(h.eng.run.status).toBe("completed");
      expect(h.llm.maxInFlight).toBe(limit);
      expect(h.eng.run.subagents.completed).toBe(28);
    }
  }, 30000);

  it("starts a subagent only after the subagents it depends on have finished", async () => {
    const h = makeHarness();
    const order: string[] = [];
    h.llm.script = cooperative(h, {
      override: (t) => {
        if (t.type === "subagent" && t.n === 1) order.push(t.agentId);
        if (t.type !== "work" || t.agentId !== "lead-astra62" || !t.tools.includes("spawn_subagents") || h.eng.all("agent").some((a) => a.parentId === "lead-astra62")) return undefined;
        const mk = (q: string, deps: string[]) => ({ question: q, role: "Checker", context: "Chain of dependent steps.", expected_output: "A verdict.", completion_criteria: "Decided.", depends_on: deps });
        return { calls: [call("spawn_subagents", { subagents: [mk("First link: establish the base case alpha one", []), mk("Second link: extend bravo to the middle range two", ["#1"]), mk("Third link: close charlie the upper range three", ["#2"])] })] };
      },
    });
    await h.eng.action("start");
    await h.drain();
    const mine = order.filter((id) => h.eng.m.agent.get(id)?.parentId === "lead-astra62");
    expect(mine).toEqual(["sub-1", "sub-2", "sub-3"]);
    const t = (id: string) => h.eng.taskOf(id);
    expect(t("sub-2")?.startedAt ?? 0).toBeGreaterThanOrEqual(t("sub-1")?.endedAt ?? Infinity);
    expect(t("sub-3")?.startedAt ?? 0).toBeGreaterThanOrEqual(t("sub-2")?.endedAt ?? Infinity);
    expect(h.eng.run.status).toBe("completed");
  });

  it("gives queued subagent work precedence over lead turns when slots are scarce", async () => {
    const h = makeHarness({ config: { speed: "medium" } });
    const started: string[] = [];
    h.llm.script = cooperative(h, { delegate: 6 });
    h.llm.gate = async (req) => {
      started.push(req.purpose.split("|")[0]);
      await new Promise((r) => setTimeout(r, 1));
    };
    await h.eng.action("start");
    await h.drain();
    // While subagents were queued, no lead turn other than a review of a subagent took a slot ahead of them.
    const firstSub = started.indexOf("subagent");
    const lastSub = started.lastIndexOf("subagent");
    const between = started.slice(firstSub, lastSub + 1).filter((x) => x !== "subagent" && x !== "subagent_review" && x !== "compact");
    expect(firstSub).toBeGreaterThan(-1);
    expect(between.filter((x) => x === "work").length).toBeLessThanOrEqual(2);
    expect(h.eng.run.status).toBe("completed");
  });
});

describe("what subagents return", () => {
  it("is reviewed by a lead running a different model before the delegating lead receives it", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h, { delegate: 3 });
    await h.eng.action("start");
    await h.drain();
    const subs = h.eng.all("agent").filter((a) => a.kind === "subagent");
    expect(subs).toHaveLength(6);
    for (const s of subs) {
      expect(s.status).toBe("completed");
      expect(s.review).toBeDefined();
      expect(s.review?.byModel).not.toBe(s.model);
      expect(h.eng.m.agent.get(s.review?.byAgent ?? "")?.kind).toBe("lead");
    }
    // The lead that asked for the work only got it back with the review attached.
    const resumed = h.llm.requests.filter((r) => r.purpose.startsWith("work|") && r.messages.some((m) => m.role === "tool" && m.results.some((x) => x.name === "await_subagents")));
    expect(resumed.length).toBeGreaterThan(0);
    for (const r of resumed) {
      const out = r.messages.flatMap((m) => (m.role === "tool" ? m.results.filter((x) => x.name === "await_subagents").map((x) => x.output) : [])).join("\n");
      expect(out).toMatch(/sub-\d+/);
      expect(out).toMatch(/review/i);
    }
    expect(h.eng.run.status).toBe("completed");
  });

  it("is marked unreviewed when no lead of a different model exists, rather than passed off as checked", async () => {
    const h = makeHarness({ config: { leads: ["astra62"], subagentModels: ["astra62"] } });
    h.llm.script = cooperative(h, { delegate: 2 });
    await h.eng.action("start");
    await h.drain();
    const subs = h.eng.all("agent").filter((a) => a.kind === "subagent");
    expect(subs).toHaveLength(2);
    for (const s of subs) {
      expect(s.review).toBeUndefined();
      expect(s.reviewNote ?? "").toMatch(/not been reviewed/);
    }
    const handed = h.llm.requests.flatMap((r) => r.messages.flatMap((m) => (m.role === "tool" ? m.results.filter((x) => x.name === "await_subagents").map((x) => x.output) : []))).join("\n");
    expect(handed).toMatch(/unreviewed|not been reviewed/i);
  });

  it("a rejected result reaches the lead as rejected, with the reviewer's reasons", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h, {
      delegate: 1,
      override: (t) => (t.type === "subagent_review" ? { calls: [call("submit_subagent_review", { verdict: "reject", issues: ["The block boundaries are off by one, so the last case was never checked."] })] } : undefined),
    });
    await h.eng.action("start");
    await h.drain();
    const subs = h.eng.all("agent").filter((a) => a.kind === "subagent");
    expect(subs.every((s) => s.review?.verdict === "reject")).toBe(true);
    const handed = h.llm.requests.flatMap((r) => r.messages.flatMap((m) => (m.role === "tool" ? m.results.filter((x) => x.name === "await_subagents").map((x) => x.output) : []))).join("\n");
    expect(handed).toMatch(/off by one/);
    expect(handed).toMatch(/reject/i);
  });

  it("cancelling a subagent cancels the subagents it started", () => {
    const h = atPhase(makeHarness(), "work");
    const top = h.eng.spawn(lead(h), specs(2, "top"));
    const kids = h.eng.spawn(top.created[0], specs(3, "kid", 100));
    expect(kids.created).toHaveLength(3);
    const n = h.eng.cancelAgent(top.created[0].id, "Superseded.");
    expect(n).toBe(4);
    for (const a of [top.created[0], ...kids.created]) expect(h.eng.m.agent.get(a.id)?.status).toBe("cancelled");
    expect(h.eng.m.agent.get(top.created[1].id)?.status).toBe("queued");
    expect(h.eng.run.subagents.cancelled).toBe(4);
  });
});
