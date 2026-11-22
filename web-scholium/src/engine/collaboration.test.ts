// How leads work together: modes, cross-review, objections, and the rules that decide what a claim may be called.
import { LABEL_NAMES } from "../shared/types";
import { atPhase, cooperative, makeHarness, useTool, type Harness } from "./testkit";

const PROOF = "Each even number in the range is written as an explicit sum of two numbers, and each summand is shown to be prime by trial division up to its square root.";

const TOPICS = ["parity of the summands", "the lower end of the range", "the upper end of the range", "trial division bounds", "twin prime pairs", "multiples of six", "residues modulo thirty", "the count of decompositions"];
let serial = 0;

async function claimBy(h: Harness, agentId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const topic = TOPICS[serial++ % TOPICS.length];
  const r = await useTool(h, agentId, "record_claim", { statement: `Result number ${serial} concerning ${topic}, as recorded by ${agentId}.`, proposed_label: "candidate", basis: "derived", argument: PROOF, ...extra }, "work");
  if (!r.ok) throw new Error(r.text);
  const id = /C\d+/.exec(r.text)?.[0];
  if (!id) throw new Error(`no claim id in: ${r.text}`);
  return id;
}

const accept = (h: Harness, leadId: string, claimId: string, extra: Record<string, unknown> = {}) =>
  useTool(h, leadId, "submit_review", { claim_id: claimId, verdict: "accept", summary: "Read every step of the argument and re-derived the case analysis independently.", ...extra });

describe("collaborative run", () => {
  it("goes from the goal to a cross-reviewed answer and a report without any user action", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h);
    expect((await h.eng.action("start")).ok).toBe(true);
    await h.drain();
    const r = h.eng.run;
    expect(r.status).toBe("completed");
    expect(r.goalReached).toBe(true);
    const goal = h.eng.m.claim.get(r.goalClaimId ?? "");
    expect(goal?.label).toBe("reviewed");
    // Both leads worked independently and each reviewed the other's claim.
    const claims = h.eng.all("claim").filter((c) => c.answersGoal);
    expect(claims.map((c) => c.team).sort()).toEqual(["lead-astra62", "lead-fable52"]);
    for (const c of claims) {
      const reviews = h.eng.all("review").filter((x) => x.claimId === c.id && x.revision === c.revision && x.verdict === "accept");
      expect(reviews).toHaveLength(1);
      expect(reviews[0].byAgent).not.toBe(c.team);
      expect(reviews[0].byModel).not.toBe(c.authorModel);
    }
    const phases = h.store.events.filter((e) => e.type === "phase").map((e) => e.text);
    for (const name of ["Understand", "Approach & execute", "Cross-review"]) expect(phases.join("\n")).toContain(name);
    expect(h.eng.all("artifact").some((a) => a.kind === "report")).toBe(true);
    expect(h.eng.all("checkpoint").length).toBeGreaterThan(0);
  });

  it("keeps the leads blind to each other's work until cross-review", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain({ until: (x) => x.eng.run.phase === "cross_review" });
    for (const req of h.llm.requests) {
      const [type, , agentId] = req.purpose.split("|");
      if (type !== "work") continue;
      const other = agentId === "lead-astra62" ? "Fable 5.2" : "Astra 6.2";
      const seen = req.messages.map((m) => (m.role === "user" ? m.text : m.role === "tool" ? m.results.map((x) => x.output).join("\n") : "")).join("\n");
      expect(seen).not.toContain(`established by ${other}`);
    }
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
  });
});

describe("objections", () => {
  it("block the reviewed label until the author answers and the objector is satisfied", async () => {
    const h = makeHarness();
    const labelsWhileOpen: string[] = [];
    h.llm.script = cooperative(h, {
      verdict: (reviewer, claimId) => (reviewer === "lead-fable52" && (h.eng.m.claim.get(claimId)?.revision ?? 1) === 1 ? "object" : "accept"),
    });
    await h.eng.action("start");
    await h.drain({ until: (x) => x.eng.run.phase === "revise" });
    const objections = h.eng.all("objection");
    expect(objections).toHaveLength(1);
    const target = h.eng.m.claim.get(objections[0].claimId);
    expect(target?.team).toBe("lead-astra62");
    expect(objections[0].status).toBe("open");
    labelsWhileOpen.push(target?.label ?? "");
    expect(target?.label).toBe("candidate");
    expect(target?.blockers.join(" ")).toMatch(/objection/i);
    expect(h.eng.run.goalReached).toBe(false);
    await h.drain();
    const after = h.eng.m.claim.get(objections[0].claimId);
    expect(after?.revision).toBe(2);
    expect(h.eng.m.objection.get(objections[0].id)?.status).toBe("resolved");
    expect(after?.label).toBe("reviewed");
    expect(h.eng.run.status).toBe("completed");
    expect(labelsWhileOpen).not.toContain("reviewed");
    const types = h.eng.all("task").map((t) => t.type);
    expect(types).toContain("revise");
    expect(types).toContain("confirm");
  });

  it("that nobody answers keep the run from declaring the goal reached", async () => {
    const h = makeHarness({ config: { limits: { maxCycles: 2 } } });
    h.llm.script = cooperative(h, { verdict: () => "object", decision: "progress" });
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.goalReached).toBe(false);
    expect(h.eng.run.status).toBe("paused");
    expect(h.eng.run.pauseReason ?? "").toMatch(/cycle/i);
    expect(h.eng.run.cycle).toBe(2);
    for (const c of h.eng.all("claim").filter((x) => x.answersGoal)) expect(c.label).not.toBe("reviewed");
    expect(h.eng.all("objection").filter((o) => o.status === "open").length).toBeGreaterThan(0);
  });

  it("give debate mode a second round of rebuttal before the leads decide", async () => {
    const rounds = async (mode: string): Promise<number> => {
      const h = makeHarness({ config: { mode, limits: { maxCycles: 1 } } });
      h.llm.script = cooperative(h, { verdict: (reviewer) => (reviewer === "lead-fable52" ? "object" : "accept") });
      await h.eng.action("start");
      await h.drain();
      return h.eng.all("task").filter((t) => t.type === "revise" && t.agentId === "lead-astra62").length;
    };
    expect(await rounds("collaborative")).toBe(1);
    expect(await rounds("debate")).toBe(2);
  });
});

describe("labels", () => {
  it("are computed from the evidence, not from what the author proposes", async () => {
    const h = atPhase(makeHarness(), "work");
    const numerical = await claimBy(h, "lead-astra62", { proposed_label: "numerical", basis: "computed" });
    expect(h.eng.m.claim.get(numerical)?.label).toBe("conjecture");
    const run = await useTool(h, "lead-astra62", "run_python", { code: "print(sum(range(10)))", purpose: "Check the small cases." });
    expect(run.ok).toBe(true);
    const exp = /E\d+/.exec(run.text)?.[0] ?? "";
    const ev = await useTool(h, "lead-astra62", "add_evidence", { claim_id: numerical, kind: "experiment", summary: "The enumeration covers every case that was claimed.", experiment_id: exp });
    expect(ev.ok).toBe(true);
    expect(h.eng.m.claim.get(numerical)?.label).toBe("numerical");

    const fromMemory = await claimBy(h, "lead-astra62", { basis: "memory", proposed_label: "candidate", argument: "" });
    expect(h.eng.m.claim.get(fromMemory)?.label).toBe("conjecture");
    const computedOnly = await claimBy(h, "lead-astra62", { basis: "computed", proposed_label: "candidate" });
    expect(["conjecture", "numerical"]).toContain(h.eng.m.claim.get(computedOnly)?.label);
    const tooThin = await claimBy(h, "lead-astra62", { proposed_label: "candidate", argument: "Obvious." });
    expect(h.eng.m.claim.get(tooThin)?.label).toBe("conjecture");

    // An author cannot grant the two highest labels to itself.
    const over = await useTool(h, "lead-astra62", "record_claim", { statement: "A self-certified statement about the middle of the range.", proposed_label: "reviewed", basis: "derived", argument: PROOF }, "work");
    const overId = /C\d+/.exec(over.text)?.[0] ?? "";
    expect(over.ok ? h.eng.m.claim.get(overId)?.label : "refused").not.toBe("reviewed");
    expect(h.eng.all("claim").some((c) => c.label === "reviewed" || c.label === "formal")).toBe(false);
    expect(Object.values(LABEL_NAMES)).toEqual(["Conjecture", "Numerical evidence", "Partial result", "Candidate proof", "Model-reviewed argument", "Formally checked theorem"]);
  });

  it("call a claim model-reviewed only once every other lead has accepted its current revision", async () => {
    const h = atPhase(makeHarness({ config: { leads: ["astra62", "fable52", "astra6"] } }));
    const c = await claimBy(h, "lead-astra62");
    expect(h.eng.m.claim.get(c)?.label).toBe("candidate");
    expect((await accept(h, "lead-astra62", c)).ok).toBe(false); // own team's claim
    expect((await accept(h, "lead-fable52", c)).ok).toBe(true);
    expect(h.eng.m.claim.get(c)?.label).toBe("candidate");
    expect(h.eng.m.claim.get(c)?.blockers.join(" ")).toMatch(/Astra 6/);
    expect((await accept(h, "lead-astra6", c)).ok).toBe(true);
    expect(h.eng.m.claim.get(c)?.label).toBe("reviewed");
    // A new revision voids the earlier reviews.
    const rev = await useTool(h, "lead-astra62", "revise_claim", { claim_id: c, change_note: "Tightened the wording of the last step.", argument_append: "The bound is attained at n = 40." });
    expect(rev.ok).toBe(true);
    expect(h.eng.m.claim.get(c)?.label).toBe("candidate");
  });

  it("do not count a review from the same model as the author", async () => {
    const h = atPhase(makeHarness({ config: { leads: ["astra62", "fable52"] } }));
    const c = await claimBy(h, "lead-astra62");
    const claim = h.eng.m.claim.get(c);
    if (!claim) throw new Error("claim missing");
    // Pretend the only other lead ran the author's model: the platform must not treat that as independent review.
    const fable = h.eng.m.agent.get("lead-fable52");
    if (!fable) throw new Error("lead missing");
    fable.model = "astra62";
    h.eng.put("agent", fable);
    await accept(h, "lead-fable52", c);
    expect(h.eng.m.claim.get(c)?.label).toBe("candidate");
    expect(h.eng.m.claim.get(c)?.blockers.join(" ")).toMatch(/different model/i);
  });

  it("refuse a rejection without an objection on record, and an acceptance while the reviewer's own objection stands", async () => {
    const h = atPhase(makeHarness());
    const c = await claimBy(h, "lead-astra62");
    const bare = await useTool(h, "lead-fable52", "submit_review", { claim_id: c, verdict: "reject", summary: "The induction step does not cover the last case of the range." });
    expect(bare.ok).toBe(false);
    expect(bare.text).toMatch(/raise_objection/);
    const own = await useTool(h, "lead-astra62", "raise_objection", { claim_id: c, severity: "major", text: "The last case of the range is not covered by the induction step." });
    expect(own.ok).toBe(false);
    const obj = await useTool(h, "lead-fable52", "raise_objection", { claim_id: c, severity: "major", text: "The last case of the range is not covered by the induction step." });
    expect(obj.ok).toBe(true);
    const x = /X\d+/.exec(obj.text)?.[0] ?? "";
    expect((await accept(h, "lead-fable52", c)).ok).toBe(false);
    // A "fix" needs a changed claim; a rebuttal needs substance.
    const lazy = await useTool(h, "lead-astra62", "respond_objection", { objection_id: x, response: "fix", text: "Fixed." });
    expect(lazy.ok).toBe(false);
    expect(lazy.text).toMatch(/revise_claim/);
    const thin = await useTool(h, "lead-astra62", "respond_objection", { objection_id: x, response: "rebut", text: "No, it is fine." });
    expect(thin.ok).toBe(false);
    // Conceding leaves the objection standing against this revision.
    const concede = await useTool(h, "lead-astra62", "respond_objection", { objection_id: x, response: "concede", text: "The objection is right: the last case is missing from the argument as written." });
    expect(concede.ok).toBe(true);
    expect(h.eng.m.objection.get(x)?.status).toBe("conceded");
    expect((await accept(h, "lead-fable52", c)).ok).toBe(false);
    expect(h.eng.m.claim.get(c)?.label).not.toBe("reviewed");
  });

  it("invalidate everything that depends on a lemma that falls", async () => {
    const h = atPhase(makeHarness());
    const lemma = await claimBy(h, "lead-astra62", { kind: "lemma" });
    const mid = await claimBy(h, "lead-astra62", { kind: "theorem", depends_on: [lemma] });
    const top = await claimBy(h, "lead-astra62", { kind: "goal", depends_on: [mid], answers_goal: true });
    const aside = await claimBy(h, "lead-astra62", { kind: "observation" });
    await accept(h, "lead-fable52", lemma);
    await accept(h, "lead-fable52", mid);
    await accept(h, "lead-fable52", top);
    expect([lemma, mid, top].map((id) => h.eng.m.claim.get(id)?.label)).toEqual(["reviewed", "reviewed", "reviewed"]);
    const w = await useTool(h, "lead-astra62", "withdraw_claim", { claim_id: lemma, reason: "The lemma is false for n = 2." });
    expect(w.ok).toBe(true);
    for (const id of [mid, top]) {
      const c = h.eng.m.claim.get(id);
      expect(c?.stale).toBe(true);
      expect(c?.label).toBe("conjecture");
      expect(c?.staleReason).toBeTruthy();
    }
    expect(h.eng.m.claim.get(aside)?.stale).toBe(false);
    expect(h.eng.m.claim.get(aside)?.label).toBe("candidate");
    expect(h.store.events.some((e) => e.type === "invalidated")).toBe(false); // events are written at flush
    h.eng.flush();
    const flagged = h.store.events.filter((e) => e.type === "invalidated").map((e) => e.text).join("\n");
    expect(flagged).toContain(mid);
    expect(flagged).toContain(top);
    expect(h.eng.goalState().reached).toBe(false);
  });

  it("drop a reviewed label when a dependency is revised after the review", async () => {
    const h = atPhase(makeHarness());
    const lemma = await claimBy(h, "lead-astra62", { kind: "lemma" });
    const top = await claimBy(h, "lead-astra62", { kind: "theorem", depends_on: [lemma] });
    await accept(h, "lead-fable52", lemma);
    await accept(h, "lead-fable52", top);
    expect(h.eng.m.claim.get(top)?.label).toBe("reviewed");
    await useTool(h, "lead-astra62", "revise_claim", { claim_id: lemma, change_note: "Weakened the hypothesis.", statement: "A weaker lemma that covers fewer cases than before." });
    expect(h.eng.m.claim.get(top)?.label).not.toBe("reviewed");
  });

  it("keep an open obligation from being papered over", async () => {
    const h = atPhase(makeHarness());
    const c = await claimBy(h, "lead-astra62");
    const ob = await useTool(h, "lead-fable52", "add_obligation", { claim_id: c, text: "Show that the trial division really runs up to the square root of each summand." });
    expect(ob.ok).toBe(true);
    const o = /O\d+/.exec(ob.text)?.[0] ?? "";
    await accept(h, "lead-fable52", c);
    expect(h.eng.m.claim.get(c)?.label).toBe("candidate");
    expect(h.eng.m.claim.get(c)?.blockers.join(" ")).toMatch(/obligation/i);
    // Only the team that raised it can discharge it.
    const self = await useTool(h, "lead-astra62", "discharge_obligation", { obligation_id: o, resolution: "It is done in the code, see the loop bound in the experiment." });
    expect(self.ok).toBe(false);
    const done = await useTool(h, "lead-fable52", "discharge_obligation", { obligation_id: o, resolution: "Checked: the loop bound is floor(sqrt(p)) and covers every summand." });
    expect(done.ok).toBe(true);
    expect(h.eng.m.claim.get(c)?.label).toBe("reviewed");
  });
});

describe("individual mode", () => {
  it("runs one lead without cross-review and never awards the reviewed label", async () => {
    const h = makeHarness({ config: { leads: ["fable52"], standard: "reviewed" } });
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.mode()).toBe("individual");
    expect(h.eng.effectiveStandard()).toBe("candidate");
    expect(h.eng.all("review")).toHaveLength(0);
    expect(h.eng.all("task").some((t) => t.type === "cross_review")).toBe(false);
    for (const c of h.eng.all("claim")) expect(["conjecture", "numerical", "partial", "candidate"]).toContain(c.label);
    expect(h.eng.run.status).toBe("completed");
    expect(h.eng.run.outcome ?? "").toMatch(/Candidate proof/);
    expect([...new Set(h.llm.ids)]).toEqual(["anthropic/claude-fable-5.2-fast"]);
  });

  it("is what a two-lead run becomes when set to individual: each lead works alone", async () => {
    const h = makeHarness({ config: { mode: "individual" } });
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.all("review")).toHaveLength(0);
    expect(h.eng.all("claim").filter((c) => c.answersGoal)).toHaveLength(2);
    for (const c of h.eng.all("claim")) expect(c.label).not.toBe("reviewed");
  });
});

describe("changing the team while a run is under way", () => {
  it("adds and removes leads, switches mode, and keeps what a removed lead recorded", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain({ until: (x) => x.eng.run.phase === "cross_review" });
    const before = h.eng.all("claim").length;
    expect(h.eng.updateConfig({ leads: ["astra62", "astra6"], mode: "debate" }).ok).toBe(true);
    expect(h.eng.mode()).toBe("debate");
    expect(h.eng.activeLeads().map((l) => l.id)).toEqual(["lead-astra62", "lead-astra6"]);
    expect(h.eng.m.agent.get("lead-fable52")?.active).toBe(false);
    expect(h.eng.all("claim").length).toBe(before);
    expect(h.eng.all("task").filter((t) => t.agentId === "lead-fable52" && (t.status === "queued" || t.status === "running"))).toHaveLength(0);
    const n = h.llm.ids.length;
    await h.drain();
    const later = h.llm.ids.slice(n);
    expect(later).toContain("openai/gpt-6-astra-fast");
    expect(later).not.toContain("anthropic/claude-fable-5.2-fast");
    // The goal cannot be rewritten once the run has started.
    const goal = h.eng.run.config.goal;
    h.eng.updateConfig({ goal: "Something else entirely." });
    expect(h.eng.run.config.goal).toBe(goal);
  });
});
