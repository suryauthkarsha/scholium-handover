// Keeping a run alive: provider errors, restarts of the host, limits, pause and stop, long contexts, a faulty sandbox.
import { ZERO_USAGE } from "../shared/models";
import { buildPack } from "./pack";
import { LlmError } from "./providers";
import { atPhase, call, cooperative, makeHarness, useTool, type Harness, type Turn } from "./testkit";

const events = (h: Harness, type: string) => h.store.events.filter((e) => e.type === type);
const overloaded = (): LlmError => new LlmError("HTTP 503 from the gateway: upstream overloaded, try again later", { status: 503, retryable: true });
const errorCalls = (h: Harness) => h.eng.calls().filter((c) => c.status === "error");

describe("provider errors", () => {
  it("retries a temporary failure with growing delays and then carries on", async () => {
    const h = makeHarness();
    const at: number[] = [];
    h.llm.script = cooperative(h, {
      override: (t) => {
        if (t.type !== "understand" || t.agentId !== "lead-astra62") return undefined;
        at.push(h.svc.clock.t);
        if (t.n <= 3) throw overloaded();
        return undefined;
      },
    });
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    // Three failures, then success on the fourth attempt, each wait at least as long as the backoff table says.
    expect(at.length).toBe(4);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(1000);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(2000);
    expect(at[3] - at[2]).toBeGreaterThanOrEqual(4000);
    const retries = events(h, "retry");
    expect(retries).toHaveLength(3);
    expect(retries[0].text).toMatch(/HTTP 503 from the gateway: upstream overloaded/);
    expect(retries[0].text).toMatch(/attempt 2 of 9/);
    // The failed attempts are on record with the provider's own status and text, at no cost.
    const failed = errorCalls(h);
    expect(failed).toHaveLength(3);
    expect(failed.every((c) => c.httpStatus === 503 && c.costUsd === 0 && /upstream overloaded/.test(c.error ?? ""))).toBe(true);
    expect(failed.map((c) => c.attempt)).toEqual([1, 2, 3]);
    // The same model was asked every time.
    expect(new Set(h.llm.requests.filter((r) => r.purpose.endsWith("|lead-astra62")).map((r) => r.model))).toEqual(new Set(["astra62"]));
  });

  it("asks for attention with the provider's own words when a model keeps failing", async () => {
    const h = makeHarness({ opts: { maxAttempts: 3 } });
    h.llm.script = cooperative(h, {
      override: (t) => {
        if (t.model === "fable52") throw overloaded();
        return undefined;
      },
    });
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("needs_attention");
    expect(h.eng.run.error).toMatch(/Claude Fable 5\.2/);
    expect(h.eng.run.error).toMatch(/HTTP 503 from the gateway: upstream overloaded/);
    expect(h.eng.run.goalReached).toBe(false);
    // No other model was put in the failing lead's place.
    expect(h.llm.requests.filter((r) => r.purpose.endsWith("|lead-fable52")).every((r) => r.model === "fable52")).toBe(true);
    expect(h.eng.activeLeads().map((l) => l.model)).toEqual(["astra62", "fable52"]);
    // The user is told at once.
    expect(h.svc.emails.some((m) => /needs you/.test(m.subject))).toBe(true);
    expect(h.eng.all("email").some((m) => m.kind === "attention" && m.status === "sent")).toBe(true);
  });

  it("can be resumed after the fault is gone and then finishes", async () => {
    const h = makeHarness({ opts: { maxAttempts: 2 } });
    let down = true;
    h.llm.script = cooperative(h, {
      override: (t) => {
        if (down && t.model === "fable52") throw overloaded();
        return undefined;
      },
    });
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("needs_attention");
    down = false;
    expect((await h.eng.action("resume")).ok).toBe(true);
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    expect(h.eng.run.goalReached).toBe(true);
    expect(h.eng.run.error).toBeUndefined();
  });

  it("gives a gateway timeout of GPT 5.5 Pro two attempts and reports it instead of switching models", async () => {
    const h = makeHarness({ config: { leads: ["gpt55pro", "fable52"] } });
    h.llm.script = cooperative(h, {
      override: (t) => {
        if (t.model === "gpt55pro") throw new LlmError("HTTP 524 from the gateway: a timeout occurred", { status: 524, retryable: true });
        return undefined;
      },
    });
    await h.eng.action("start");
    await h.drain();
    const first = h.eng.all("task").find((t) => t.agentId === "lead-gpt55pro" && t.type === "understand");
    expect(first?.status).toBe("failed");
    expect(errorCalls(h).filter((c) => c.taskId === first?.id)).toHaveLength(2);
    expect(events(h, "retry")[0].text).toMatch(/attempt 2 of 2/);
    expect(h.eng.run.status).toBe("needs_attention");
    expect(h.eng.run.error).toMatch(/524/);
    expect(h.llm.ids.filter((id) => id === "openai/gpt-5.5-pro").length).toBeGreaterThan(0);
    expect(h.llm.requests.filter((r) => r.purpose.endsWith("|lead-gpt55pro")).every((r) => r.model === "gpt55pro")).toBe(true);
  });
});

describe("a restart of the host in the middle of a run", () => {
  it("resumes every interrupted task from its saved transcript and finishes without repeating recorded work", async () => {
    const h = makeHarness();
    let frozen = false;
    h.llm.script = cooperative(h, { delegate: 2 });
    h.llm.gate = () => (frozen ? new Promise<void>(() => undefined) : Promise.resolve());
    await h.eng.action("start");
    await h.drain({ until: (x) => x.eng.run.phase === "work" && x.eng.all("agent").filter((a) => a.kind === "subagent").length === 4 && x.eng.all("experiment").length >= 1 });
    expect(h.eng.run.status).toBe("running");
    // The next calls never return: the process dies with them in flight.
    frozen = true;
    await h.eng.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.eng.inFlight.size).toBeGreaterThan(0);
    const spentBefore = h.eng.run.spend.usd;
    const claimsBefore = h.eng.all("claim").length;
    const expBefore = h.eng.all("experiment").length;

    const h2 = h.reload();
    frozen = false;
    h2.llm.script = cooperative(h2, { delegate: 2 });
    expect(h2.eng.run.status).toBe("running");
    expect(h2.eng.run.spend.usd).toBeCloseTo(spentBefore, 6);
    expect(h2.eng.run.spend.reservedUsd).toBe(0);
    expect(h2.eng.all("claim")).toHaveLength(claimsBefore);
    expect(h2.eng.all("experiment")).toHaveLength(expBefore);
    const restarted = h2.eng.all("task").filter((t) => t.restarts > 0);
    expect(restarted.length).toBeGreaterThan(0);
    expect(restarted.every((t) => t.status === "queued")).toBe(true);
    expect(h2.store.events.some((e) => e.type === "run" && /host restarted/.test(e.text))).toBe(true);

    await h2.drain();
    expect(h2.eng.run.status).toBe("completed");
    expect(h2.eng.run.goalReached).toBe(true);
    // Nothing was created twice: one goal claim per team, the same four subagents.
    expect(h2.eng.all("claim").filter((c) => c.answersGoal && c.status === "active")).toHaveLength(2);
    expect(h2.eng.all("agent").filter((a) => a.kind === "subagent")).toHaveLength(4);
    expect(h2.eng.run.subagents.created).toBe(4);
    expect(h2.eng.run.spend.usd).toBeGreaterThan(spentBefore);
  });

  it("answers the tool calls an interrupted turn left unanswered instead of losing or replaying them", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain({ until: (x) => x.eng.run.phase === "work" });
    // Cut a transcript the way a crash between the model's answer and the tool results would.
    const task = h.eng.all("task").find((t) => t.type === "work" && t.agentId === "lead-astra62");
    if (!task) throw new Error("no work task");
    await h.drain({ until: (x) => (x.eng.transcript(task.id)?.msgs.length ?? 0) >= 3 });
    await h.eng.idle();
    h.eng.flush();
    const msgs = h.store.loadMsgs(task.id);
    let cut = -1;
    msgs.forEach((m, i) => {
      if (m.role === "assistant" && m.calls.length) cut = i;
    });
    expect(cut).toBeGreaterThan(0);
    const lost = msgs[cut].role === "assistant" ? (msgs[cut] as { calls: { name: string }[] }).calls.map((c) => c.name) : [];
    h.store.writeMsgs(task.id, cut + 1, []);
    const stored = h.eng.m.task.get(task.id);
    h.store.putEntity("task", task.id, { ...stored, status: "running" });
    const h2 = h.reload();
    h2.llm.script = cooperative(h2);
    const seen: Turn[] = [];
    const inner = h2.llm.script;
    h2.llm.script = (t) => {
      if (t.taskId === task.id) seen.push(t);
      return inner(t);
    };
    await h2.drain();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].lastResults.length).toBeGreaterThan(0);
    expect(seen[0].lastResults.map((r) => r.name)).toEqual(lost);
    expect(seen[0].lastResults.every((r) => r.isError && /interrupted by a platform restart/.test(r.output))).toBe(true);
    expect(h2.eng.run.status).toBe("completed");
  });
});

describe("pause, resume and stop", () => {
  it("pause starts nothing new, resume carries on to the end", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain({ until: (x) => x.eng.run.phase === "work" });
    expect((await h.eng.action("pause")).ok).toBe(true);
    await h.eng.idle();
    expect(h.eng.run.status).toBe("paused");
    expect(h.eng.run.pauseReason).toMatch(/Paused by you/);
    const made = h.llm.requests.length;
    for (let i = 0; i < 6; i++) {
      h.svc.clock.t += 60000;
      await h.eng.tick();
      await h.eng.idle();
    }
    expect(h.llm.requests.length).toBe(made);
    const active = h.eng.run.activeMs;
    expect((await h.eng.action("pause")).ok).toBe(false);
    expect((await h.eng.action("resume")).ok).toBe(true);
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    // Time spent paused is not counted as working time.
    expect(h.eng.run.activeMs - active).toBeLessThan(6 * 60000);
  });

  it("stop cancels queued and running work, aborts calls in flight and keeps the record", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h, { delegate: 3 });
    let hold = false;
    const aborted: string[] = [];
    h.llm.gate = (req) =>
      hold
        ? new Promise<void>((resolve) => {
            req.signal?.addEventListener("abort", () => {
              aborted.push(req.purpose);
              resolve();
            });
          })
        : Promise.resolve();
    await h.eng.action("start");
    await h.drain({ until: (x) => x.eng.all("agent").filter((a) => a.kind === "subagent").length === 6 });
    hold = true;
    await h.eng.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.eng.inFlight.size).toBeGreaterThan(0);
    const claims = h.eng.all("claim").length;
    const spend = h.eng.run.spend.usd;
    expect((await h.eng.action("stop")).ok).toBe(true);
    await h.eng.idle();
    hold = false;
    expect(aborted.length).toBeGreaterThan(0);
    expect(h.eng.run.status).toBe("stopped");
    expect(h.eng.all("task").every((t) => ["done", "failed", "cancelled"].includes(t.status))).toBe(true);
    expect(h.eng.all("agent").filter((a) => a.kind === "subagent").every((a) => ["completed", "failed", "cancelled"].includes(a.status))).toBe(true);
    expect(h.eng.all("claim")).toHaveLength(claims);
    expect(h.eng.run.spend.usd).toBeCloseTo(spend, 6);
    expect(h.eng.run.spend.reservedUsd).toBe(0);
    expect(h.eng.all("checkpoint").some((c) => c.reason === "stopped")).toBe(true);
    const made = h.llm.requests.length;
    for (let i = 0; i < 4; i++) {
      h.svc.clock.t += 30000;
      await h.eng.tick();
      await h.eng.idle();
    }
    expect(h.llm.requests.length).toBe(made);
    expect((await h.eng.action("stop")).ok).toBe(false);
    // A stopped run can be taken up again; it starts a new cycle from the ledger.
    expect((await h.eng.action("resume")).ok).toBe(true);
    expect(h.eng.run.cycle).toBe(2);
    expect(h.eng.run.phase).toBe("work");
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
  });
});

describe("limits", () => {
  it("does not make a single call when the spend limit cannot cover it", async () => {
    const h = makeHarness({ config: { limits: { spendUsd: 1 } } });
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("paused");
    expect(h.eng.run.pauseReason).toMatch(/does not cover the next model call/);
    expect(h.llm.requests).toHaveLength(0);
    expect(h.eng.run.spend.usd).toBe(0);
    expect(h.svc.emails.some((m) => /needs you/.test(m.subject))).toBe(true);
    // Raising the limit and resuming is enough.
    expect(h.eng.updateConfig({ limits: { spendUsd: 60 } }).ok).toBe(true);
    expect((await h.eng.action("resume")).ok).toBe(true);
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
  });

  it("pauses before the spend limit is exceeded, never after", async () => {
    // One call's worst case is a little over $4 here, so $4.50 pays for a handful of calls and no more.
    const LIMIT = 4.5;
    const h = makeHarness({ config: { limits: { spendUsd: LIMIT } } });
    let peak = 0;
    h.llm.script = cooperative(h, {
      override: () => {
        peak = Math.max(peak, h.eng.run.spend.usd + h.eng.run.spend.reservedUsd);
        return undefined;
      },
    });
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("paused");
    expect(h.eng.run.pauseReason).toMatch(/spend limit/);
    const made = h.llm.requests.length;
    expect(made).toBeGreaterThan(0);
    // What was spent plus what was held for calls in flight never went past the limit.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(LIMIT + 1e-9);
    expect(h.eng.run.spend.usd).toBeLessThanOrEqual(LIMIT);
    expect(h.eng.run.spend.reservedUsd).toBe(0);
    expect(h.eng.run.goalReached).toBe(false);
    // Resuming without raising the limit cannot buy another call.
    await h.eng.action("resume");
    await h.drain();
    expect(h.eng.run.status).toBe("paused");
    expect(h.llm.requests.length).toBe(made);
    expect(h.eng.run.spend.usd).toBeLessThanOrEqual(LIMIT);
  });

  it("pauses at the runtime limit and continues once it is raised", async () => {
    const h = makeHarness({ config: { limits: { runtimeMin: 5 } } });
    h.llm.script = cooperative(h, {
      override: () => {
        h.svc.clock.t += 45000;
        return undefined;
      },
    });
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("paused");
    expect(h.eng.run.pauseReason).toMatch(/runtime limit of 5 minutes/);
    expect(h.eng.run.activeMs).toBeGreaterThanOrEqual(5 * 60000);
    expect((await h.eng.action("resume")).ok).toBe(false);
    expect(h.eng.updateConfig({ limits: { runtimeMin: 600 } }).ok).toBe(true);
    expect((await h.eng.action("resume")).ok).toBe(true);
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
  });

  it("set to work until the spending limit ignores the time and cycle limits and stops at the spend limit", async () => {
    const h = makeHarness({ config: { limits: { untilSpend: true, maxCycles: 1, runtimeMin: 5, spendUsd: 10 } } });
    h.llm.script = cooperative(h, {
      verdict: () => "object",
      decision: "progress",
      override: () => {
        h.svc.clock.t += 45000;
        return undefined;
      },
    });
    await h.eng.action("start");
    await h.drain();
    const r = h.eng.run;
    expect(r.status).toBe("paused");
    expect(r.pauseReason).toMatch(/spend limit/);
    expect(r.cycle).toBeGreaterThan(1);
    expect(r.activeMs).toBeGreaterThan(5 * 60000);
    expect(r.goalReached).toBe(false);
  });
});

describe("long contexts", () => {
  const OBLIGATION = "Show that trial division by 2, 3 and 5 suffices for every summand below 40.";

  /** One lead records an obligation in a turn that reports a very large context, which forces a rebuild before its next turn. */
  function longRun(compactReply: "handoff" | "nothing" | "error") {
    const h = makeHarness();
    const after: Turn[] = [];
    // The transcript array is live, so its length is noted at the moment of the call.
    const sizes: number[] = [];
    h.llm.script = cooperative(h, {
      override: (t) => {
        if (t.type === "compact") {
          if (compactReply === "nothing") return { text: "" };
          if (compactReply === "error") throw new LlmError("HTTP 500 from the gateway: internal error", { status: 500, retryable: false });
          return undefined;
        }
        if (t.type !== "work" || t.agentId !== "lead-astra62") return undefined;
        const claim = h.eng.all("claim").find((c) => c.team === "lead-astra62" && c.answersGoal);
        if (!claim) return undefined;
        const obs = h.eng.all("obligation").filter((o) => o.claimId === claim.id);
        if (!obs.length) return { calls: [call("add_obligation", { claim_id: claim.id, text: OBLIGATION })], usage: { input: 150000, cacheRead: 0, cacheWrite: 0, output: 400, reasoning: 0 } };
        const open = obs.find((o) => o.status === "open");
        if (open) {
          after.push(t);
          sizes.push(t.req.messages.length);
          return { calls: [call("discharge_obligation", { obligation_id: open.id, resolution: "Every summand is below 40, so its square root is below 7 and trial division by 2, 3 and 5 decides primality." })] };
        }
        return undefined;
      },
    });
    return { h, after, sizes };
  }

  it("are rebuilt from the ledger with the model's handoff, and open obligations survive the rebuild", async () => {
    const { h, after, sizes } = longRun("handoff");
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    const ev = events(h, "compaction");
    expect(ev).toHaveLength(1);
    expect(ev[0].text).toMatch(/handoff written by the model/);
    const compactCalls = h.llm.requests.filter((r) => r.purpose.startsWith("compact|"));
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0].tools.map((t) => t.name)).toEqual(["save_progress"]);
    // The first turn after the rebuild starts from one fresh briefing that still carries the obligation and the handoff.
    expect(after).toHaveLength(1);
    expect(sizes).toEqual([1]);
    expect(after[0].userText).toContain(OBLIGATION);
    expect(after[0].userText).toMatch(/Open proof obligations/);
    expect(after[0].userText).toMatch(/Handoff: the approach is committed/);
    const task = h.eng.all("task").find((t) => t.id === after[0].taskId);
    expect(task?.compactions).toBe(1);
    expect(h.eng.all("obligation").every((o) => o.status === "discharged")).toBe(true);
  });

  it("fall back to a handoff written by the platform when the model gives none or its call fails", async () => {
    for (const mode of ["nothing", "error"] as const) {
      const { h, after, sizes } = longRun(mode);
      await h.eng.action("start");
      await h.drain();
      expect(h.eng.run.status).toBe("completed");
      const ev = events(h, "compaction");
      expect(ev).toHaveLength(1);
      expect(ev[0].text).toMatch(/handoff written by the platform/);
      expect(sizes).toEqual([1]);
      expect(after[0].userText).toContain(OBLIGATION);
      expect(after[0].userText).toMatch(/platform wrote this handoff/);
      expect(after[0].userText).toMatch(/add_obligation/);
    }
  });

  it("are rebuilt when the provider refuses a request as too long", async () => {
    const h = makeHarness();
    let refused = 0;
    h.llm.script = cooperative(h, {
      override: (t) => {
        if (t.type === "work" && t.agentId === "lead-fable52" && t.req.messages.length >= 5 && refused < 1) {
          refused++;
          throw new LlmError("HTTP 400 from the gateway: prompt is too long: 1048576 tokens > 1000000 maximum", { status: 400, retryable: false });
        }
        return undefined;
      },
    });
    await h.eng.action("start");
    await h.drain();
    expect(refused).toBe(1);
    expect(h.eng.run.status).toBe("completed");
    const ev = events(h, "compaction");
    expect(ev).toHaveLength(1);
    expect(ev[0].text).toMatch(/refused the request as too long/);
    expect(events(h, "retry")).toHaveLength(0);
  });

  it("every briefing lists standing objections and open obligations, whoever reads it", async () => {
    const h = atPhase(makeHarness(), "work");
    const made = await useTool(h, "lead-astra62", "record_claim", { statement: "Every even integer n with 4 <= n <= 40 is a sum of two primes.", proposed_label: "candidate", basis: "derived", argument: "Each case is listed with an explicit pair of primes, and each summand is checked by trial division.", kind: "goal", answers_goal: true });
    expect(made.ok).toBe(true);
    const claim = h.eng.all("claim")[0];
    h.eng.run.phase = "cross_review";
    h.eng.touch();
    expect((await useTool(h, "lead-fable52", "raise_objection", { claim_id: claim.id, severity: "major", text: "The case n = 38 is listed as 19 + 19, but the argument never checks that 19 is prime." })).ok).toBe(true);
    expect((await useTool(h, "lead-fable52", "add_obligation", { claim_id: claim.id, text: "Give the primality check for every summand explicitly." })).ok).toBe(true);
    for (const id of ["lead-astra62", "lead-fable52"]) {
      const agent = h.eng.m.agent.get(id);
      if (!agent) throw new Error("no agent");
      for (const type of ["cross_review", "revise", "confirm", "decide"] as const) {
        const pack = buildPack(h.eng, h.eng.newLeadTask(type, agent), agent);
        expect(pack).toMatch(/never checks that 19 is prime/);
        expect(pack).toMatch(/Give the primality check for every summand explicitly/);
      }
    }
  });
});

describe("the code sandbox", () => {
  const run = (h: Harness, who = "lead-astra62") => useTool(h, who, "run_python", { code: "print(sum(range(10)))", purpose: "Add the integers below ten." });

  it("records real output with both integrity checks passed", async () => {
    const h = atPhase(makeHarness(), "work");
    h.llm.sandbox.run = () => ({ exit: 0, stdout: "45\n" });
    const r = await run(h);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/integrity checks passed/);
    expect(r.text).toContain("45");
    const x = h.eng.all("experiment")[0];
    expect(x.status).toBe("ok");
    expect(x.verified).toEqual({ command: true, transcript: true });
    expect(x.stdout).toBe("45\n");
    expect(h.llm.relays).toHaveLength(1);
    expect(h.llm.relays[0].command).toContain("print(sum(range(10)))");
    // The run is billed and on record like any other model call.
    const rec = h.eng.calls().find((c) => c.purpose === "sandbox:python");
    expect(rec?.status).toBe("ok");
    expect(rec?.costUsd).toBeGreaterThan(0);
  });

  it.each([
    ["altered-command", /differs from the submitted code/],
    ["altered-output", /NOT VERIFIED/],
    ["no-transcript", /no transcript/],
    ["error", /sandbox unavailable/],
  ] as const)("rejects a run whose relay came back with fault %s, shows no output and refuses it as evidence", async (fault, pattern) => {
    const h = atPhase(makeHarness(), "work");
    h.llm.sandbox.run = () => ({ exit: 0, stdout: "45\n" });
    h.llm.sandbox.fault = fault;
    const r = await run(h);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/NOT VERIFIED/);
    expect(r.text).toMatch(pattern);
    expect(r.text).not.toContain("45\n");
    const x = h.eng.all("experiment")[0];
    expect(x.status).toBe("infra_error");
    expect(x.stdout).toBe("");
    // A fault that may pass is retried; a refusal by the gateway is not.
    expect(h.llm.relays.length).toBe(fault === "error" ? 1 : 3);
    const claim = await useTool(h, "lead-astra62", "record_claim", { statement: "The integers below ten sum to 45.", proposed_label: "numerical", basis: "computed" });
    expect(claim.ok).toBe(true);
    const ev = await useTool(h, "lead-astra62", "add_evidence", { claim_id: h.eng.all("claim")[0].id, kind: "experiment", summary: "The program printed 45.", experiment_id: x.id });
    expect(ev.ok).toBe(false);
    expect(ev.text).toMatch(/cannot be used as evidence/);
    expect(h.eng.all("claim")[0].label).toBe("conjecture");
  });

  it("does not count a program that failed or timed out as evidence", async () => {
    const h = atPhase(makeHarness(), "work");
    h.llm.sandbox.run = () => ({ exit: 1, stdout: "", stderr: "ZeroDivisionError: division by zero" });
    const failed = await run(h);
    expect(failed.text).toMatch(/A failed run is not evidence/);
    expect(failed.text).toMatch(/ZeroDivisionError/);
    h.llm.sandbox.run = () => ({ exit: 124, stdout: "partial" });
    const slow = await run(h);
    expect(slow.text).toMatch(/time limit was hit/);
    const [a, b] = h.eng.all("experiment").sort((x, y) => x.id.localeCompare(y.id));
    expect([a.status, b.status]).toEqual(["error", "timeout"]);
    await useTool(h, "lead-astra62", "record_claim", { statement: "The quotient is finite.", proposed_label: "numerical", basis: "computed" });
    for (const x of [a, b]) expect((await useTool(h, "lead-astra62", "add_evidence", { claim_id: h.eng.all("claim")[0].id, kind: "experiment", summary: "See the run.", experiment_id: x.id })).ok).toBe(false);
  });

  it("is switched off after three infrastructure failures in a row, and tried again later", async () => {
    const h = atPhase(makeHarness(), "work");
    h.llm.sandbox.fault = "no-transcript";
    for (let i = 0; i < 2; i++) await run(h);
    expect(h.eng.toolOk("sandbox")).toBe(true);
    await run(h);
    expect(h.eng.toolOk("sandbox")).toBe(false);
    expect(h.eng.run.toolStatus.sandbox?.detail).toMatch(/3 infrastructure failures/);
    const refused = await run(h);
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/not offered/);
    // Leads are told not to plan around it.
    const agent = h.eng.m.agent.get("lead-fable52");
    if (!agent) throw new Error("no agent");
    expect(buildPack(h.eng, h.eng.newLeadTask("work", agent), agent)).toMatch(/Code execution: unavailable/);
    // After a quarter of an hour it gets one trial; a success restores it.
    h.svc.clock.t += 16 * 60000;
    h.eng.tickSync();
    expect(h.eng.toolOk("sandbox")).toBe(true);
    h.llm.sandbox.fault = "none";
    const again = await run(h);
    expect(again.text).toMatch(/integrity checks passed/);
    expect(h.eng.run.counters.infra_sandbox).toBe(0);
    await h.eng.idle();
  });

  it("is not run at all when the spend limit leaves no room for it", async () => {
    const h = atPhase(makeHarness({ config: { limits: { spendUsd: 1 } } }), "work");
    h.eng.run.spend.usd = 0.999;
    const r = await run(h);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/spend limit leaves no room/);
    expect(h.llm.relays).toHaveLength(0);
    expect(h.eng.all("experiment")).toHaveLength(0);
    expect(ZERO_USAGE.input).toBe(0);
  });
});
