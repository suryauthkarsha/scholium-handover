// Test doubles for the engine: a scripted model gateway, fake outside services with a clock the test controls,
// and a harness that drives the engine the way the hosting Durable Object does. Nothing here is used in production.
import { MODELS, type ModelKey, type Usage } from "../shared/models";
import type { RunSummary, SandboxExecutor, ServerMsg, TaskType, ToolStatus } from "../shared/types";
import { Engine, type EngineOpts } from "./engine";
import { LlmError, type Llm, type LlmRequest, type LlmResponse, type RelayResult } from "./providers";
import { EXECUTOR_MODEL } from "./sandbox";
import type { DriveApi, EmailMessage, EmailResult, FetchedDoc, LeanOutcome, OeisEntry, Paper, Services, WebResult } from "./services";
import { MemoryStore } from "./store";
import { ToolError, toolsFor, type ToolOutcome } from "./tools";
import { sha256Hex } from "./util";

export interface ScriptCall {
  name: string;
  args?: Record<string, unknown>;
  badJson?: string;
}

export interface Reply {
  text?: string;
  thinking?: string;
  calls?: ScriptCall[];
  usage?: Usage;
  providerModel?: string;
  truncated?: boolean;
  dropped?: string[];
  stop?: string;
}

export interface Turn {
  req: LlmRequest;
  /** Task type, e.g. "work", "subagent", or "compact". */
  type: TaskType | "compact";
  taskId: string;
  agentId: string;
  model: ModelKey;
  /** 1-based count of calls made for this task so far. */
  n: number;
  /** Names of the tools offered in this call. */
  tools: string[];
  /** Outputs of the tool results in the last message, if it is one. */
  lastResults: { name: string; output: string; isError?: boolean }[];
  /** All user-role text in the transcript, joined. */
  userText: string;
}

export type Script = (t: Turn) => Reply | Promise<Reply>;

export const call = (name: string, args: Record<string, unknown> = {}): ScriptCall => ({ name, args });
export const DEFAULT_USAGE: Usage = { input: 1000, cacheRead: 0, cacheWrite: 0, output: 200, reasoning: 50 };

const abortError = (): Error => {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
};

export interface SandboxFake {
  /** What the sandbox prints for a piece of code. */
  run: (code: string, lang: string) => { exit?: number; stdout?: string; stderr?: string };
  /** Ways the relay can go wrong. */
  fault: "none" | "altered-command" | "altered-output" | "no-transcript" | "error";
}

export class FakeLlm implements Llm {
  script: Script = () => ({ text: "" });
  requests: LlmRequest[] = [];
  /** Exact gateway ids that would have been sent. */
  ids: string[] = [];
  relays: { executor: SandboxExecutor; command: string }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  /** When set, every call waits for this before answering. */
  gate?: (req: LlmRequest) => Promise<void>;
  sandbox: SandboxFake = { run: () => ({ exit: 0, stdout: "ok\n", stderr: "" }), fault: "none" };
  private perTask = new Map<string, number>();
  private seq = 0;

  async call(req: LlmRequest): Promise<LlmResponse> {
    const spec = MODELS[req.model];
    this.requests.push(req);
    this.ids.push(spec.id);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await Promise.resolve();
      if (this.gate) await this.gate(req);
      if (req.signal?.aborted) throw abortError();
      const [type, taskId, agentId] = req.purpose.split("|");
      const n = (this.perTask.get(req.purpose) ?? 0) + 1;
      this.perTask.set(req.purpose, n);
      const last = req.messages[req.messages.length - 1];
      const turn: Turn = {
        req,
        type: type as Turn["type"],
        taskId,
        agentId,
        model: req.model,
        n,
        tools: req.tools.map((t) => t.name),
        lastResults: last && last.role === "tool" ? last.results.map((r) => ({ name: r.name, output: r.output, isError: r.isError })) : [],
        userText: req.messages.map((m) => (m.role === "user" ? m.text : "")).join("\n"),
      };
      const r = await this.script(turn);
      if (req.signal?.aborted) throw abortError();
      const id = ++this.seq;
      const calls = (r.calls ?? []).map((c, i) => ({ id: `call_${id}_${i}`, name: c.name, args: c.args ?? {}, ...(c.badJson !== undefined ? { badJson: c.badJson } : {}) }));
      if (r.text) req.onDelta?.("text", r.text);
      const providerModel = r.providerModel ?? `${spec.reportedMatch}-2026-10-01`;
      const reported: Record<string, string> = { model: providerModel, effort: spec.effort };
      if (!providerModel.includes(spec.reportedMatch)) reported.mismatch = `expected a model name containing "${spec.reportedMatch}"`;
      return {
        text: r.text ?? "",
        thinking: r.thinking ?? "",
        calls,
        raw: [{ fake: id }],
        dropped: r.dropped ?? [],
        usage: r.usage ?? { ...DEFAULT_USAGE },
        stop: r.stop ?? (calls.length ? "tool_use" : "end_turn"),
        truncated: r.truncated ?? false,
        gatewayModel: spec.id,
        providerModel,
        requested: { effort: spec.effort, maxOutput: req.maxOutput },
        reported,
        ms: 5,
      };
    } finally {
      this.inFlight--;
    }
  }

  async relay(executor: SandboxExecutor, _system: string, command: string, signal?: AbortSignal): Promise<RelayResult> {
    await Promise.resolve();
    if (signal?.aborted) throw abortError();
    this.relays.push({ executor, command });
    const model = EXECUTOR_MODEL[executor];
    const base = { usage: { input: 2000, cacheRead: 0, cacheWrite: 0, output: 300, reasoning: 0 }, model, providerModel: `${MODELS[model].reportedMatch}-2026-10-01`, ms: 7 };
    const f = this.sandbox.fault;
    if (f === "error") throw new LlmError("HTTP 500 from the gateway: sandbox unavailable", { status: 500, retryable: false });
    const m = /cat > (job\.py|job\.sh) <<'([^']+)'\n([\s\S]*?)\n\2\n/.exec(command);
    const code = m ? m[3] : "";
    const out = this.sandbox.run(code, m && m[1] === "job.py" ? "python" : "bash");
    const stdout = out.stdout ?? "";
    const body = JSON.stringify({ exit: out.exit ?? 0, stdout, stderr: out.stderr ?? "", python: "3.13.1", stdout_chars: stdout.length, full_stdout_sha256: await sha256Hex(stdout) });
    const sha = await sha256Hex(body);
    const shown = f === "altered-output" ? body.replace(/"stdout":"/, '"stdout":"edited ') : body;
    return {
      ...base,
      commands: [f === "altered-command" ? `${command}\necho tampered` : command],
      transcript: f === "no-transcript" ? undefined : `SX-BEGIN\n${shown}\nSX-SHA256 ${sha}\nSX-END`,
    };
  }
}

export class FakeServices implements Services {
  clock = { t: Date.UTC(2026, 10, 21, 9, 0, 0) };
  llm: FakeLlm;
  web: WebResult[] = [];
  papers: Paper[] = [];
  docs = new Map<string, FetchedDoc>();
  oeisEntries: OeisEntry[] = [];
  leanOutcome: LeanOutcome = { ok: false, errors: [], warnings: [], infos: [], versions: "", log: "", infraError: "No Lean server is configured." };
  health: Record<string, { ok: boolean; detail: string }> = {};
  emails: EmailMessage[] = [];
  emailMode: EmailResult["status"] = "sent";
  driveConnected = false;
  driveFiles = new Map<string, { folderId: string; name: string; mime: string; content: string; writes: number }>();
  driveFolders: string[] = [];
  driveFail: string | null = null;
  searches: string[] = [];

  constructor(llm: FakeLlm) {
    this.llm = llm;
  }
  now(): number {
    return this.clock.t;
  }
  async webSearch(query: string): Promise<{ results: WebResult[]; via: string }> {
    this.searches.push(query);
    return { results: this.web, via: "exa (test)" };
  }
  async literature(query: string): Promise<{ papers: Paper[]; backends: Record<string, string> }> {
    this.searches.push(query);
    return { papers: this.papers, backends: { crossref: "ok", arxiv: "ok" } };
  }
  async fetchDocument(url: string): Promise<FetchedDoc> {
    const d = this.docs.get(url);
    if (!d) throw new Error(`HTTP 404 fetching ${url}`);
    return d;
  }
  async oeis(): Promise<OeisEntry[]> {
    return this.oeisEntries;
  }
  async sage(): Promise<{ ok: boolean; stdout: string; error?: string }> {
    return { ok: false, stdout: "", error: "SageMathCell is not reachable in tests." };
  }
  async lean(): Promise<LeanOutcome> {
    return this.leanOutcome;
  }
  async email(msg: EmailMessage): Promise<EmailResult> {
    if (this.emailMode === "skipped") return { status: "skipped", detail: "No email key is configured.", to: "" };
    if (this.emailMode === "failed") return { status: "failed", detail: "HTTP 403 from the email provider", to: "owner@example.com" };
    this.emails.push(msg);
    return { status: "sent", detail: "accepted (id test)", to: "owner@example.com" };
  }
  drive: DriveApi = {
    status: async () => ({ connected: this.driveConnected, detail: this.driveConnected ? "Connected as owner@example.com" : "Google Drive is not connected." }),
    ensureRunFolder: async (title: string) => {
      const id = `folder-${this.driveFolders.length + 1}`;
      this.driveFolders.push(title);
      return { id, url: `https://drive.google.com/drive/folders/${id}` };
    },
    putFile: async (folderId: string, name: string, mime: string, content: string, existingFileId?: string) => {
      if (this.driveFail) throw new Error(this.driveFail);
      const id = existingFileId ?? `file-${this.driveFiles.size + 1}`;
      const prev = this.driveFiles.get(id);
      this.driveFiles.set(id, { folderId, name, mime, content, writes: (prev?.writes ?? 0) + 1 });
      return id;
    },
  };
  async preflight(tool: string): Promise<ToolStatus> {
    const h = this.health[tool] ?? (tool === "sage" || tool === "lean" ? { ok: false, detail: `${tool} is not available in tests.` } : { ok: true, detail: "ok" });
    return { ...h, checkedAt: this.clock.t };
  }
}

export interface Harness {
  store: MemoryStore;
  llm: FakeLlm;
  svc: FakeServices;
  eng: Engine;
  sent: ServerMsg[];
  wakes: number[];
  summaries: RunSummary[];
  /** Ticks the engine until the run leaves the running state, `until` holds, or `max` ticks have passed. Returns the ticks used. */
  drain(o?: { until?: (h: Harness) => boolean; max?: number }): Promise<number>;
  /** A new engine over the same storage, as after the hosting object was evicted. */
  reload(): Harness;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export function makeHarness(o: { config?: Record<string, unknown>; opts?: Partial<EngineOpts>; store?: MemoryStore; llm?: FakeLlm; svc?: FakeServices; init?: boolean } = {}): Harness {
  const store = o.store ?? new MemoryStore();
  const llm = o.llm ?? new FakeLlm();
  const svc = o.svc ?? new FakeServices(llm);
  const sent: ServerMsg[] = [];
  const wakes: number[] = [];
  const summaries: RunSummary[] = [];
  let pending: number[] = [];
  const eng = new Engine(
    store,
    svc,
    {
      broadcast: (m) => void sent.push(m),
      wake: (d) => {
        wakes.push(d);
        pending.push(d);
      },
      summary: (s) => void summaries.push(s),
    },
    { backoffMs: [1000, 2000, 4000, 8000], ...o.opts },
  );
  const h: Harness = {
    store,
    llm,
    svc,
    eng,
    sent,
    wakes,
    summaries,
    async drain(d = {}) {
      const max = d.max ?? 400;
      let i = 0;
      for (; i < max; i++) {
        pending = [];
        await eng.tick();
        await eng.idle();
        await settle();
        if (d.until?.(h)) break;
        if (eng.run.status !== "running" && !eng.inFlight.size && !eng.jobs.size) break;
        // Move the clock the way the host's timer would: to the earliest wake-up the engine asked for.
        const next = pending.length ? Math.min(...pending) : eng.opts.heartbeatMs;
        svc.clock.t += Math.max(1, next);
      }
      await eng.idle();
      await settle();
      return i;
    },
    reload() {
      return makeHarness({ store, llm, svc, opts: o.opts, init: false });
    },
  };
  if (o.init === false) {
    eng.load();
  } else {
    eng.init({ id: "run-test", ownerHash: "owner-hash", config: { title: "Test run", goal: "Decide whether every even integer greater than 2 and at most 40 is a sum of two primes.", ...o.config }, origin: "https://scholium.test" });
  }
  return h;
}

/** Puts a fresh run straight into a phase, with both leads' approaches committed, so single tools can be exercised without scripting whole turns. */
export function atPhase(h: Harness, phase: "work" | "cross_review" | "revise" | "confirm" = "cross_review"): Harness {
  const r = h.eng.run;
  r.status = "running";
  r.cycle = 1;
  r.phase = phase;
  r.startedAt = h.svc.clock.t;
  r.lastTickAt = h.svc.clock.t;
  for (const l of h.eng.activeLeads()) r.approachCommitted[l.id] = 1;
  h.eng.touch();
  return h;
}

export interface ToolReply {
  ok: boolean;
  text: string;
  outcome?: ToolOutcome;
}

/** Calls one tool as the given agent, the way a task of the given type would, and returns what the model would be told. */
export async function useTool(h: Harness, agentId: string, name: string, args: Record<string, unknown> = {}, taskType?: TaskType): Promise<ToolReply> {
  const eng = h.eng;
  const agent = eng.m.agent.get(agentId);
  if (!agent) throw new Error(`There is no agent ${agentId}.`);
  const type: TaskType = taskType ?? (agent.kind === "subagent" ? "subagent" : eng.run.phase === "work" ? "work" : eng.run.phase === "revise" ? "revise" : eng.run.phase === "confirm" ? "confirm" : "cross_review");
  const task = eng.taskOf(agentId) ?? eng.newTask(type, agent, { title: "direct tool call", maxTurns: 10, maxOutput: 4000 });
  const probe = task.type === type ? task : { ...task, type };
  const spec = toolsFor(eng, probe, agent).find((t) => t.def.name === name);
  if (!spec) return { ok: false, text: `The tool ${name} is not offered to ${agentId} in a ${type} task.` };
  try {
    const r = await spec.run({ eng, task: probe, agent, signal: new AbortController().signal, callId: "direct" }, args);
    return typeof r === "string" ? { ok: true, text: r } : { ok: true, text: r.output, outcome: r };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, text: e.message };
    throw e;
  }
}

// ---------- a cooperative team of scripted models ----------
export interface Scenario {
  /** Label each lead proposes for its goal claim. */
  label?: "conjecture" | "numerical" | "partial" | "candidate";
  basis?: "derived" | "retrieved" | "computed" | "memory";
  /** Subagents each lead delegates to in its first work phase. */
  delegate?: number;
  /** The verdict a lead gives another team's claim. Defaults to accept. */
  verdict?: (reviewerId: string, claimId: string) => "accept" | "object" | "cannot_assess";
  decision?: "reached" | "progress" | "stalled";
  /** Return a reply to replace the default behaviour for one turn. */
  override?: (t: Turn) => Reply | undefined | Promise<Reply | undefined>;
}

const PROOF =
  "For each even n with 4 <= n <= 40 an explicit pair of primes summing to n is listed in the linked experiment output, and each listed number is checked to be prime by trial division; the finite list of cases is therefore exhausted.";
const REPORT = (goal: string | undefined): string =>
  `## Answer\n\nThe question is settled for the stated range${goal ? ` by [[${goal}]]` : ""}. Each even integer in the range was decomposed explicitly and the decomposition was re-derived independently by the other lead before it was accepted.\n\n## How it was established\n\nBoth leads enumerated the cases with their own code, compared the outputs, and reviewed each other's written argument. No step relies on a result that was not produced or retrieved in this run, and the remaining limits of the argument are listed by the platform below.\n`;

/** A script in which every model does its job plainly. Tests override single turns to create the situation they need. */
export function cooperative(h: Harness, o: Scenario = {}): Script {
  const spawned = new Set<string>();
  const awaited = new Set<string>();
  return async (t) => {
    const over = await o.override?.(t);
    if (over) return over;
    const eng = h.eng;
    const me = eng.m.agent.get(t.agentId);
    if (!me) return { text: "" };
    const has = (name: string): boolean => t.tools.includes(name);
    const myExp = (): string | undefined =>
      eng
        .all("experiment")
        .filter((x) => x.byAgent === me.id && x.status === "ok")
        .sort((a, b) => b.createdAt - a.createdAt || Number(b.id.slice(1)) - Number(a.id.slice(1)))[0]?.id;
    const python = call("run_python", { code: `print("pairs for ${me.id} turn ${t.n}")`, purpose: "Enumerate the prime pairs for every even n in the range." });
    switch (t.type) {
      case "compact":
        return { calls: [call("save_progress", { handoff: "Handoff: the approach is committed and the enumeration is done; continue from the ledger and submit when the remaining checks pass." })] };
      case "understand":
        return { calls: [call("submit_understanding", { restatement: "Decide the statement for every even integer in the stated finite range.", success_criteria: "An explicit decomposition for every case, independently reproduced.", subquestions: ["Which cases are there?"], risks: ["An off-by-one error at the ends of the range."] })] };
      case "prior_work":
        return { calls: [call("submit_prior_work", { summary: "The general statement is open; the finite range asked about is elementary and can be settled by enumeration." })] };
      case "work": {
        if (has("commit_approach") && !has("submit_work")) return { calls: [call("commit_approach", { approach: "Enumerate the range directly.", plan: "Compute the pairs, then write the argument.", abandon_if: "A case without a pair turns up." })] };
        if (o.delegate && !spawned.has(me.id)) {
          spawned.add(me.id);
          const subagents = Array.from({ length: o.delegate }, (_, i) => ({ question: `Verify block ${i + 1} of the range for ${me.id}: list a prime pair for each even number in it (${"abcdefghij"[i % 10]}${i}).`, role: "Computation", context: "Part of a finite enumeration.", expected_output: "A list of pairs.", completion_criteria: "Every case in the block is covered." }));
          return { calls: [call("spawn_subagents", { subagents })] };
        }
        if (o.delegate && !awaited.has(t.taskId)) {
          awaited.add(t.taskId);
          return { calls: [call("await_subagents", {})] };
        }
        const claim = eng.all("claim").find((c) => c.team === me.team && c.answersGoal && c.status === "active");
        if (!claim) {
          if (!myExp()) return { calls: [python] };
          return { calls: [call("record_claim", { statement: `Every even integer n with 4 <= n <= 40 is a sum of two primes (established by ${me.name}).`, proposed_label: o.label ?? "candidate", basis: o.basis ?? "derived", argument: PROOF, kind: "goal", answers_goal: true })] };
        }
        const linked = eng.all("evidence").some((e) => e.claimId === claim.id && e.revision === claim.revision);
        const exp = myExp();
        if (!linked && exp) return { calls: [call("add_evidence", { claim_id: claim.id, kind: "experiment", summary: "The enumeration prints a prime pair for every case in the range.", experiment_id: exp })] };
        return { calls: [call("submit_work", { summary: `The range is enumerated and the argument is written into ${claim.id}.`, claim_ids: [claim.id] })] };
      }
      case "cross_review":
      case "confirm": {
        const mine = eng.all("objection").filter((x) => x.team === me.team && x.status === "answered");
        if (mine.length) return { calls: [call("resolve_objection", { objection_id: mine[0].id, outcome: "resolved", text: "The revised claim repairs the problem; I re-checked the changed step." })] };
        const q = eng.reviewQueue(me.id);
        if (q.length) {
          const c = q[0];
          const v = o.verdict?.(me.id, c.id) ?? "accept";
          if (v === "object") {
            const standing = eng.all("objection").some((x) => x.claimId === c.id && x.team === me.team && x.status === "open");
            if (!standing) return { calls: [call("raise_objection", { claim_id: c.id, severity: "major", text: "The argument does not show that the listed numbers are prime; the primality check is asserted, not carried out." })] };
            return { calls: [call("submit_review", { claim_id: c.id, verdict: "reject", summary: "The primality of the listed summands is asserted without a check, so the argument has a gap." })] };
          }
          if (v === "cannot_assess") return { calls: [call("submit_review", { claim_id: c.id, verdict: "cannot_assess", summary: "The computation could not be reproduced here, so the claim could not be verified." })] };
          const ev = eng.all("evidence").filter((e) => e.claimId === c.id && e.revision === c.revision);
          const fresh = eng.all("experiment").find((x) => x.byAgent === me.id && x.purpose.includes(c.id));
          if (ev.some((e) => e.experimentId) && !fresh) return { calls: [call("run_python", { code: `print("recheck ${c.id} by ${me.id}")`, purpose: `Reproduce the enumeration behind ${c.id} with independent code.` })] };
          return { calls: [call("submit_review", { claim_id: c.id, verdict: "accept", summary: "Recomputed every case with independent code and read the argument line by line; found no gap.", citations_audited: ev.filter((e) => e.kind === "citation").map((e) => e.id), recomputed: fresh ? [fresh.id] : [], satisfies_goal: true })] };
        }
        return { calls: [call(t.type === "confirm" ? "submit_confirmation" : "submit_cross_review", { summary: "All claims in my queue are reviewed." })] };
      }
      case "revise": {
        const open = eng.all("objection").find((x) => (x.status === "open" || x.status === "unresolved") && eng.m.claim.get(x.claimId)?.team === me.team);
        if (open) {
          const c = eng.m.claim.get(open.claimId);
          if (c && c.revision <= open.revision) return { calls: [call("revise_claim", { claim_id: c.id, change_note: `Answers ${open.id}: the primality check is now spelled out.`, argument_append: " Each summand is checked to be prime by trial division up to its square root, and the check is part of the experiment output." })] };
          return { calls: [call("respond_objection", { objection_id: open.id, response: "fix", text: "The claim was revised: the primality check is now explicit in the argument and in the experiment." })] };
        }
        return { calls: [call("submit_revision", { summary: "Every objection addressed to my team is answered." })] };
      }
      case "decide":
        return { calls: [call("submit_decision", { status: o.decision ?? "progress", reasoning: "The ledger shows where the claim stands.", next_focus: "Close the remaining review gaps on the goal claim." })] };
      case "report":
        return { calls: [call("submit_report", { markdown: REPORT(eng.run.goalClaimId) })] };
      case "subagent": {
        if (!myExp()) return { calls: [python] };
        return { calls: [call("submit_result", { answer: "Every case in the block has a prime pair; the pairs are in the experiment output.", findings: ["All cases covered."], experiment_ids: [myExp() ?? ""].filter(Boolean), confidence: "High: direct enumeration." })] };
      }
      case "subagent_review":
        return { calls: [call("submit_subagent_review", { verdict: "accept", issues: [] })] };
      default:
        return { text: "" };
    }
  };
}
