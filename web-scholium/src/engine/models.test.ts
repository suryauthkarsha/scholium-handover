// Which models may be called, with what settings, and what happens when a provider answers as something else.
import { ALLOWED_MODEL_IDS, MODELS, MODEL_KEYS, assertAllowed, isModelKey } from "../shared/models";
import { SPEED_CONCURRENCY, defaultConfig } from "../shared/types";
import { sanitizeConfig } from "./engine";
import { LlmError } from "./providers";
import { cooperative, makeHarness, type Script } from "./testkit";

const PERMITTED = ["anthropic/claude-fable-5.2-fast", "openai/gpt-5.5-pro", "openai/gpt-6-astra-fast", "openai/gpt-6.2-astra-fast"];

describe("model allowlist", () => {
  it("holds exactly the four permitted gateway ids", () => {
    expect([...ALLOWED_MODEL_IDS].sort()).toEqual(PERMITTED);
    expect(MODEL_KEYS.map((k) => MODELS[k].id).sort()).toEqual(PERMITTED);
    expect(Object.keys(MODELS)).toHaveLength(4);
  });

  it("asks each model for the highest effort it supports", () => {
    expect(MODELS.astra62.effort).toBe("max");
    expect(MODELS.astra6.effort).toBe("max");
    expect(MODELS.fable52.effort).toBe("max");
    expect(MODELS.gpt55pro.effort).toBe("xhigh");
    expect(MODELS.gpt55pro.effortNote).toMatch(/xhigh/);
  });

  it("refuses any id that is not on the list", () => {
    for (const id of PERMITTED) expect(() => assertAllowed(id)).not.toThrow();
    for (const id of ["openai/gpt-6.2-astra", "openai/gpt-4o", "anthropic/claude-fable-5.2", "openai/gpt-5.5-pro-fast", ""]) expect(() => assertAllowed(id)).toThrow(/allowlist/);
    expect(isModelKey("astra62")).toBe(true);
    expect(isModelKey("gpt-4o")).toBe(false);
  });

  it("defaults to GPT-6.2 Astra and Claude Fable 5.2 as the two leads", () => {
    expect(defaultConfig().leads).toEqual(["astra62", "fable52"]);
    expect(sanitizeConfig({ goal: "g" }).leads).toEqual(["astra62", "fable52"]);
  });

  it("drops models it does not know instead of substituting another one for them", () => {
    const c = sanitizeConfig({ leads: ["gpt-4o", "astra6", "claude-opus"], subagentModels: ["o3", "gpt55pro"] });
    expect(c.leads).toEqual(["astra6"]);
    expect(c.subagentModels).toEqual(["gpt55pro"]);
  });

  it("lets the speed setting change parallelism and nothing else", () => {
    expect(SPEED_CONCURRENCY).toEqual({ medium: 4, fast: 8, ultrafast: 16 });
    const base = sanitizeConfig({ goal: "g", speed: "medium" });
    for (const speed of ["medium", "fast", "ultrafast"] as const) {
      const c = sanitizeConfig({ goal: "g", speed });
      expect(c.limits.concurrency).toBe(SPEED_CONCURRENCY[speed]);
      expect({ ...c, speed: "x", limits: { ...c.limits, concurrency: 0 } }).toEqual({ ...base, speed: "x", limits: { ...base.limits, concurrency: 0 } });
    }
  });

  it("clamps limits and never allows more than 200 subagents", () => {
    const c = sanitizeConfig({ limits: { subagentCap: 5000, maxDepth: 9, spendUsd: -3, runtimeMin: 1, maxCycles: 0 }, alerts: { intervalMin: 1 } });
    expect(c.limits.subagentCap).toBe(200);
    expect(c.limits.maxDepth).toBe(5);
    expect(c.limits.spendUsd).toBe(1);
    expect(c.limits.runtimeMin).toBe(5);
    expect(c.limits.maxCycles).toBe(1);
    expect(c.alerts.intervalMin).toBe(5);
  });
});

describe("calls made during a run", () => {
  it("go only to allowlisted ids, at the required effort, and each one is recorded with what was asked and what came back", async () => {
    const h = makeHarness({ config: { leads: ["astra62", "fable52", "astra6", "gpt55pro"] } });
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    expect(h.llm.ids.length).toBeGreaterThan(20);
    for (const id of h.llm.ids) expect(PERMITTED).toContain(id);
    expect(new Set(h.llm.ids).size).toBe(4);
    const calls = h.eng.calls().filter((c) => !c.purpose.startsWith("sandbox:"));
    expect(calls.length).toBe(h.llm.ids.length);
    for (const c of calls) {
      expect(c.gatewayModel).toBe(MODELS[c.model].id);
      expect(c.requested.effort).toBe(MODELS[c.model].effort);
      expect(c.requested.maxOutput).toBeGreaterThan(0);
      expect(c.reported.model).toContain(MODELS[c.model].reportedMatch);
      expect(c.reported.mismatch).toBeUndefined();
      expect(c.status).toBe("ok");
    }
    // Code execution is relayed through an allowlisted model too, and is recorded as such.
    const relayed = h.eng.calls().filter((c) => c.purpose.startsWith("sandbox:"));
    expect(relayed.length).toBeGreaterThan(0);
    for (const c of relayed) expect(PERMITTED).toContain(c.gatewayModel);
  });

  it("report a provider that answers as a different model, once, and carry on without swapping models", async () => {
    const h = makeHarness();
    const base = cooperative(h);
    const script: Script = async (t) => {
      const r = await base(t);
      return t.model === "fable52" ? { ...r, providerModel: "claude-sonnet-4-20250514" } : r;
    };
    h.llm.script = script;
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    const errors = h.store.events.filter((e) => e.type === "model" && e.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toMatch(/claude-sonnet-4-20250514/);
    expect(h.eng.run.counters.mismatch_fable52).toBeGreaterThan(1);
    const fable = h.eng.calls().filter((c) => c.model === "fable52" && !c.purpose.startsWith("sandbox:"));
    expect(fable.length).toBeGreaterThan(3);
    for (const c of fable) {
      expect(c.gatewayModel).toBe("anthropic/claude-fable-5.2-fast");
      expect(c.providerModel).toBe("claude-sonnet-4-20250514");
      expect(c.reported.mismatch).toBeTruthy();
    }
    // Nothing was re-routed: the only ids ever sent are those of the two configured leads.
    expect([...new Set(h.llm.ids)].sort()).toEqual(["anthropic/claude-fable-5.2-fast", "openai/gpt-6.2-astra-fast"]);
  });

  it("show the provider's own error text when a model cannot be used, and ask for attention instead of using another model", async () => {
    const h = makeHarness();
    const base = cooperative(h);
    h.llm.script = async (t) => {
      if (t.model === "fable52") throw new LlmError('HTTP 404 from the gateway: {"error":{"message":"model anthropic/claude-fable-5.2-fast is not available to this key"}}', { status: 404, retryable: false });
      return base(t);
    };
    await h.eng.action("start");
    await h.drain();
    const texts = h.store.events.map((e) => e.text).join("\n");
    expect(texts).toMatch(/is not available to this key/);
    const failed = h.eng.calls().filter((c) => c.status === "error");
    expect(failed.length).toBeGreaterThan(0);
    for (const c of failed) {
      expect(c.model).toBe("fable52");
      expect(c.httpStatus).toBe(404);
      expect(c.error).toMatch(/is not available to this key/);
    }
    expect(h.eng.run.status).toBe("needs_attention");
    expect(h.eng.run.error ?? "").not.toBe("");
    expect([...new Set(h.llm.ids)].sort()).toEqual(["anthropic/claude-fable-5.2-fast", "openai/gpt-6.2-astra-fast"]);
  });
});
