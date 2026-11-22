// The complete model allowlist. Nothing outside this file may ever be sent to the gateway.

export type ModelKey = "astra62" | "astra6" | "fable52" | "gpt55pro";
export type Effort = "max" | "xhigh";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
  /** Above this many input tokens the higher tier applies to the whole call. */
  tierAbove?: number;
  tierInput?: number;
  tierOutput?: number;
}

export interface ModelSpec {
  key: ModelKey;
  /** Exact gateway id. */
  id: string;
  label: string;
  short: string;
  vendor: "OpenAI" | "Anthropic";
  api: "responses" | "messages";
  effort: Effort;
  effortNote?: string;
  /** Substring the provider-reported model name must contain. */
  reportedMatch: string;
  price: ModelPrice;
  contextWindow: number;
  maxOutput: number;
  /** CSS custom property holding this model's colour. */
  color: string;
  caveat?: string;
}

export const MODELS: Record<ModelKey, ModelSpec> = {
  astra62: {
    key: "astra62",
    id: "openai/gpt-6.2-astra-fast",
    label: "GPT-6.2 Astra (Fast)",
    short: "Astra 6.2",
    vendor: "OpenAI",
    api: "responses",
    effort: "max",
    reportedMatch: "gpt-6.2-astra",
    price: { input: 0.000016, output: 0.00008, cacheRead: 0.0000008, tierAbove: 272001, tierInput: 0.000032, tierOutput: 0.00012 },
    contextWindow: 1050000,
    maxOutput: 128000,
    color: "--m-astra62",
  },
  astra6: {
    key: "astra6",
    id: "openai/gpt-6-astra-fast",
    label: "GPT-6 Astra (Fast)",
    short: "Astra 6",
    vendor: "OpenAI",
    api: "responses",
    effort: "max",
    reportedMatch: "gpt-6-astra",
    price: { input: 0.00002, output: 0.0001, cacheRead: 0.000002, tierAbove: 272001, tierInput: 0.00004, tierOutput: 0.00015 },
    contextWindow: 1050000,
    maxOutput: 128000,
    color: "--m-astra6",
  },
  fable52: {
    key: "fable52",
    id: "anthropic/claude-fable-5.2-fast",
    label: "Claude Fable 5.2 (Fast)",
    short: "Fable 5.2",
    vendor: "Anthropic",
    api: "messages",
    effort: "max",
    reportedMatch: "claude-fable-5.2",
    price: { input: 0.000016, output: 0.00008, cacheRead: 0.0000004, cacheWrite: 0.00002 },
    contextWindow: 1000000,
    maxOutput: 128000,
    color: "--m-fable52",
  },
  gpt55pro: {
    key: "gpt55pro",
    id: "openai/gpt-5.5-pro",
    label: "GPT 5.5 Pro",
    short: "5.5 Pro",
    vendor: "OpenAI",
    api: "responses",
    effort: "xhigh",
    effortNote: "This model's highest supported effort is xhigh (it has no max setting).",
    reportedMatch: "gpt-5.5-pro",
    price: { input: 0.00003, output: 0.00018, cacheRead: 0.00003, tierAbove: 272000, tierInput: 0.00006, tierOutput: 0.00027 },
    contextWindow: 1000000,
    maxOutput: 128000,
    color: "--m-gpt55pro",
    caveat:
      "The gateway does not stream this model and drops any single turn that takes longer than about two minutes (HTTP 524). Long turns fail and are reported as failures.",
  },
};

export const MODEL_KEYS: ModelKey[] = ["astra62", "fable52", "astra6", "gpt55pro"];
export const DEFAULT_LEADS: ModelKey[] = ["astra62", "fable52"];
export const ALLOWED_MODEL_IDS: ReadonlySet<string> = new Set(MODEL_KEYS.map((k) => MODELS[k].id));

export function isModelKey(v: unknown): v is ModelKey {
  return typeof v === "string" && (MODEL_KEYS as string[]).includes(v);
}

/** Throws unless the id is one of the four allowed gateway ids. Called before every request. */
export function assertAllowed(id: string): void {
  if (!ALLOWED_MODEL_IDS.has(id)) throw new Error(`Model "${id}" is not on the allowlist; refusing to call it.`);
}

export interface Usage {
  /** Uncached input tokens. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Output tokens, including reasoning tokens. */
  output: number;
  reasoning: number;
}

export const ZERO_USAGE: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

export function costOf(key: ModelKey, u: Usage): number {
  const p = MODELS[key].price;
  const totalIn = u.input + u.cacheRead + u.cacheWrite;
  const tier = p.tierAbove !== undefined && totalIn >= p.tierAbove;
  const inP = tier && p.tierInput ? p.tierInput : p.input;
  const outP = tier && p.tierOutput ? p.tierOutput : p.output;
  return u.input * inP + u.cacheRead * p.cacheRead + u.cacheWrite * (p.cacheWrite ?? inP) + u.output * outP;
}

/** Worst-case cost of one call, used to reserve budget before dispatch. */
export function worstCaseCost(key: ModelKey, inputTokens: number, maxOutput: number): number {
  return costOf(key, { input: inputTokens, cacheRead: 0, cacheWrite: 0, output: maxOutput, reasoning: 0 });
}
