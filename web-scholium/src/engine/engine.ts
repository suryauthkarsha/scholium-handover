// The run engine: owns a run's state, enforces its limits and drives its tasks.
// It is deliberately free of platform code: storage, model calls and timers come in through interfaces,
// so the same engine runs inside a Durable Object and inside the tests.
import { DEFAULT_LEADS, MODELS, ZERO_USAGE, addUsage, isModelKey, worstCaseCost, type ModelKey, type Usage } from "../shared/models";
import { BASE_METHOD, type ActiveMethod } from "./strategy";
import {
  ENTITY_KINDS,
  LABELS,
  SPEED_CONCURRENCY,
  SUBAGENT_HARD_CAP,
  DEPTH_HARD_CAP,
  defaultConfig,
  labelRank,
  type ActivityEvent,
  type Agent,
  type CallRecord,
  type Claim,
  type EntityKind,
  type EntityMap,
  type Instruction,
  type Label,
  type Mode,
  type Msg,
  type Phase,
  type RunConfig,
  type RunState,
  type RunSummary,
  type ServerMsg,
  type Snapshot,
  type Source,
  type Task,
  type TaskType,
  type Upload,
} from "../shared/types";
import { checkpoint, exportCheckpoint, importCheckpoint, notify, runBackground, type CheckpointExport } from "./background";
import { AGENT_TERMINAL, LEAD_TASKS, TERMINAL } from "./consts";
import { assess, goalStatus, type GoalStatus, type LedgerCtx } from "./ledger";
import { advance, newLeadTask, prepareResume } from "./phases";
import { buildReport, dataFrom, toLatex } from "./report";
import type { Services } from "./services";
import { resumeWaiting, runStep } from "./step";
import type { SearchHit, Store } from "./store";
import { normId } from "./tools";
import { clip, errText, estTokens, fmtUsd, oneLine, sha256Hex, similarity } from "./util";

export interface EngineHooks {
  /** Sends a message to every connected viewer of the run. */
  broadcast(msg: ServerMsg): void;
  /** Asks to be ticked again after this many milliseconds. */
  wake(delayMs: number): void | Promise<void>;
  /** Reports the run's one-line summary to the project list. */
  summary?(s: RunSummary): void;
}

export interface EngineOpts {
  compactAtTokens: number;
  maxStartsPerTick: number;
  backoffMs: number[];
  heartbeatMs: number;
  maxAttempts: number;
  driveSyncMs: number;
}

/** How often a running engine re-reads the adopted working-method notes. */
const METHOD_REFRESH_MS = 5 * 60_000;

export const DEFAULT_OPTS: EngineOpts = {
  compactAtTokens: 120000,
  maxStartsPerTick: 5,
  backoffMs: [2000, 6000, 18000, 45000, 90000, 180000, 300000, 300000],
  heartbeatMs: 20000,
  maxAttempts: 9,
  driveSyncMs: 600000,
};

export interface SpawnSpec {
  question: string;
  role: string;
  context: string;
  sources: string[];
  expectedOutput: string;
  completionCriteria: string;
  dependsOn: string[];
  maxTurns: number;
  budgetUsd: number;
  model?: ModelKey;
}

export interface SourceMeta {
  kind: Source["kind"];
  title: string;
  url?: string;
  authors: string[];
  date?: string;
  venue?: string;
  doi?: string;
  arxivId?: string;
  via: string;
  complete?: boolean;
  uploadId?: string;
}

export type EntityMaps = { [K in EntityKind]: Map<string, EntityMap[K]> };
export type ActionResult = { ok: true } | { ok: false; error: string };

export const MAX_SOURCE_CHARS = 2_000_000;
export const MAX_UPLOAD_BYTES = 12_000_000;
export const MAX_UPLOADS = 40;
export { AGENT_TERMINAL, LEAD_TASKS, TERMINAL };
const PRIORITY: Record<string, number> = { subagent: 0, subagent_review: 1 };
const PREFLIGHT_TOOLS = ["web", "literature", "oeis", "sage", "lean"] as const;
type ToolName = "web" | "literature" | "oeis" | "sandbox" | "sage" | "lean";

const zeroUsage = (): Usage => ({ ...ZERO_USAGE });
const num = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown, d: string, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : d);
function modelList(v: unknown, d: ModelKey[]): ModelKey[] {
  const out = Array.isArray(v) ? [...new Set(v.filter(isModelKey))] : [];
  return out.length ? out : [...d];
}

/** Turns untrusted input into a valid configuration. Unknown models are dropped; numbers are clamped; nothing can exceed the hard caps. */
export function sanitizeConfig(input: unknown, base: RunConfig = defaultConfig()): RunConfig {
  const i = obj(input);
  const l = obj(i.limits);
  const t = obj(i.tools);
  const a = obj(i.alerts);
  const leads = "leads" in i ? modelList(i.leads, DEFAULT_LEADS) : base.leads;
  const speed = (["medium", "fast", "ultrafast"] as const).find((s) => s === i.speed) ?? base.speed;
  const mode = (["individual", "collaborative", "debate"] as const).find((s) => s === i.mode) ?? base.mode;
  const subs = "subagentModels" in i ? modelList(i.subagentModels, leads) : base.subagentModels.length ? base.subagentModels : leads;
  return {
    title: text(i.title, base.title, 160),
    goal: text(i.goal, base.goal, 30000),
    acceptance: text(i.acceptance, base.acceptance, 8000),
    standard: LABELS.find((x) => x === i.standard) ?? base.standard,
    leads,
    subagentModels: subs,
    mode,
    speed,
    limits: {
      spendUsd: num(l.spendUsd, base.limits.spendUsd, 1, 20000),
      runtimeMin: Math.round(num(l.runtimeMin, base.limits.runtimeMin, 5, 20160)),
      maxCycles: Math.round(num(l.maxCycles, base.limits.maxCycles, 1, 500)),
      untilSpend: bool(l.untilSpend, base.limits.untilSpend),
      concurrency: SPEED_CONCURRENCY[speed],
      subagentCap: Math.round(num(l.subagentCap, base.limits.subagentCap, 0, SUBAGENT_HARD_CAP)),
      maxDepth: Math.round(num(l.maxDepth, base.limits.maxDepth, 1, DEPTH_HARD_CAP)),
    },
    tools: {
      web: bool(t.web, base.tools.web),
      literature: bool(t.literature, base.tools.literature),
      sandbox: bool(t.sandbox, base.tools.sandbox),
      sandboxExecutor: t.sandboxExecutor === "fable-bash" || t.sandboxExecutor === "astra-shell" ? t.sandboxExecutor : base.tools.sandboxExecutor,
      sage: bool(t.sage, base.tools.sage),
      lean: bool(t.lean, base.tools.lean),
      oeis: bool(t.oeis, base.tools.oeis),
    },
    alerts: {
      enabled: bool(a.enabled, base.alerts.enabled),
      intervalMin: Math.round(num(a.intervalMin, base.alerts.intervalMin, 5, 1440)),
      onGoal: bool(a.onGoal, base.alerts.onGoal),
      onAttention: bool(a.onAttention, base.alerts.onAttention),
    },
    drive: bool(i.drive, base.drive),
  };
}

function emptyMaps(): EntityMaps {
  const m: Record<string, Map<string, unknown>> = {};
  for (const k of ENTITY_KINDS) m[k] = new Map();
  return m as unknown as EntityMaps;
}

const normUrl = (u?: string): string =>
  (u ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "");

export function uploadKind(name: string, mime: string): Upload["kind"] {
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (/^image\/(png|jpe?g|gif|webp)$/i.test(mime)) return "image";
  if (/^text\//.test(mime) || /\.(txt|md|tex|bib|csv|tsv|json|py|lean|sage|m|nb|r|jl|c|cpp|h|hs|ml|rs|yaml|yml|xml|html?)$/i.test(name)) return "text";
  return "other";
}

export class Engine {
  run!: RunState;
  m: EntityMaps = emptyMaps();
  opts: EngineOpts;
  loaded = false;
  /** Steps running right now, by task id. */
  inFlight = new Map<string, Promise<void>>();
  aborts = new Map<string, AbortController>();
  /** Background jobs (email, Drive, tool checks) running right now, by key. */
  jobs = new Map<string, Promise<void>>();
  private transcripts = new Map<string, Msg[]>();
  private msgFrom = new Map<string, number>();
  private evict = new Set<string>();
  private dirty = new Map<string, { kind: EntityKind; id: string; del: boolean }>();
  private pendingEvents: ActivityEvent[] = [];
  private moreToStart = false;
  /** The adopted working-method notes, appended to every agent's instructions. Kept current from the workspace. */
  method: ActiveMethod = BASE_METHOD;
  private methodAt = 0;
  private methodBusy: Promise<void> | null = null;

  constructor(
    public store: Store,
    public services: Services,
    public hooks: EngineHooks,
    opts: Partial<EngineOpts> = {},
  ) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  // ---------- basics ----------
  now(): number {
    return this.services.now();
  }

  id(prefix: string): string {
    const n = (this.run.counters[prefix] ?? 0) + 1;
    this.run.counters[prefix] = n;
    this.touch();
    return `${prefix}${n}`;
  }

  put<K extends EntityKind>(kind: K, e: EntityMap[K]): void {
    this.m[kind].set(e.id, e);
    this.dirty.set(`${kind}:${e.id}`, { kind, id: e.id, del: false });
  }

  del(kind: EntityKind, id: string): void {
    if (!this.m[kind].delete(id)) return;
    this.dirty.set(`${kind}:${id}`, { kind, id, del: true });
  }

  all<K extends EntityKind>(kind: K): EntityMap[K][] {
    return [...this.m[kind].values()];
  }

  touch(): void {
    this.put("run", this.run);
  }

  event(level: ActivityEvent["level"], type: string, message: string, agentId?: string, ref?: string): void {
    this.pendingEvents.push({ seq: ++this.run.seq, at: this.now(), level, type, text: clip(message, 700), agentId, ref });
    this.touch();
  }

  // ---------- persistence ----------
  init(p: { id: string; ownerHash: string; config: unknown; origin?: string; import?: CheckpointExport; branchedFrom?: { runId: string; checkpointId: string } }): void {
    const now = this.now();
    this.m = emptyMaps();
    this.run = {
      id: p.id,
      ownerHash: p.ownerHash,
      config: sanitizeConfig(p.config, p.import ? p.import.config : defaultConfig()),
      status: "draft",
      phase: "setup",
      cycle: p.import ? p.import.cycle : 0,
      createdAt: now,
      activeMs: 0,
      goalReached: false,
      stalledStreak: 0,
      approachCommitted: {},
      subagents: { created: 0, running: 0, queued: 0, completed: 0, failed: 0, cancelled: 0 },
      capRaised: true,
      spend: { usd: 0, reservedUsd: 0, calls: 0, usage: zeroUsage() },
      toolStatus: {},
      counters: {},
      branchedFrom: p.branchedFrom,
      origin: p.origin,
      reviseRound: 0,
      seq: 0,
    };
    this.touch();
    this.syncLeads();
    if (p.import) importCheckpoint(this, p.import);
    this.event("info", "run", p.branchedFrom ? `Branch created from checkpoint ${p.branchedFrom.checkpointId} of an earlier run.` : "Run created.");
    this.loaded = true;
    this.flush();
  }

  /** Restores the run after the hosting object was restarted. Returns false if nothing is stored. */
  load(): boolean {
    const ents = this.store.loadEntities();
    if (!ents.length) return false;
    this.m = emptyMaps();
    for (const e of ents) (this.m[e.kind] as Map<string, unknown> | undefined)?.set(e.id, e.data);
    const run = this.all("run")[0];
    if (!run) return false;
    this.run = run;
    let interrupted = 0;
    for (const t of this.m.task.values()) {
      const wasRunning = t.status === "running";
      if (wasRunning) {
        // The step that was in flight is gone with the old process; the task resumes from its saved transcript.
        t.status = "queued";
        t.restarts++;
        interrupted++;
      }
      if (wasRunning || t.reservedUsd) {
        t.reservedUsd = 0;
        this.put("task", t);
      }
    }
    run.spend.reservedUsd = 0;
    if (run.status === "running") run.lastTickAt = this.now();
    // Projects made while 100 was the most a project could have are moved to the new limit once.
    let raised = false;
    if (run.capRaised !== true) {
      raised = run.config.limits.subagentCap === 100 && SUBAGENT_HARD_CAP > 100;
      if (raised) run.config = { ...run.config, limits: { ...run.config.limits, subagentCap: SUBAGENT_HARD_CAP } };
      run.capRaised = true;
    }
    this.touch();
    this.loaded = true;
    if (raised) this.event("info", "run", `The limit on subagents for this project went from 100 to ${SUBAGENT_HARD_CAP}. The spending limit is unchanged.`);
    if (interrupted) this.event("warn", "run", `The run's host restarted; ${interrupted} task${interrupted === 1 ? "" : "s"} resumed from the last saved turn.`);
    this.flush();
    return true;
  }

  /** Writes every pending change in one transaction, then tells the viewers. */
  flush(): void {
    if (!this.dirty.size && !this.pendingEvents.length && !this.msgFrom.size) return;
    const dirty = [...this.dirty.values()];
    const events = this.pendingEvents;
    const msgs = [...this.msgFrom];
    this.dirty = new Map();
    this.pendingEvents = [];
    this.msgFrom = new Map();
    this.store.transaction(() => {
      for (const d of dirty) {
        const data = this.m[d.kind].get(d.id);
        if (d.del || !data) this.store.delEntity(d.kind, d.id);
        else this.store.putEntity(d.kind, d.id, data);
      }
      for (const [taskId, from] of msgs) this.store.writeMsgs(taskId, from, (this.transcripts.get(taskId) ?? []).slice(from));
      for (const e of events) this.store.appendEvent(e);
    });
    for (const id of [...this.evict]) {
      if (this.inFlight.has(id)) continue;
      this.transcripts.delete(id);
      this.evict.delete(id);
    }
    let runChanged = false;
    for (const d of dirty) {
      if (d.kind === "call") continue;
      const data = this.m[d.kind].get(d.id);
      if (d.kind === "run") runChanged = true;
      if (d.del || !data) this.hooks.broadcast({ t: "del", kind: d.kind, id: d.id });
      else this.hooks.broadcast({ t: "put", kind: d.kind, id: d.id, data: d.kind === "run" ? this.publicRun() : data });
    }
    for (const e of events) this.hooks.broadcast({ t: "event", event: e });
    if (runChanged) this.hooks.summary?.(this.summary());
  }

  publicRun(): RunState {
    return { ...this.run, ownerHash: "" };
  }

  snapshot(): Snapshot {
    const s: Record<string, unknown[]> = {};
    for (const k of ENTITY_KINDS) s[k] = this.all(k);
    return s as Snapshot;
  }

  /** What a viewer receives: everything except raw call records and the owner hash. */
  publicSnapshot(): Snapshot {
    const s = this.snapshot();
    delete s.call;
    s.run = [this.publicRun()];
    return s;
  }

  summary(): RunSummary {
    const r = this.run;
    return {
      id: r.id,
      title: r.config.title || oneLine(r.config.goal, 70),
      goal: oneLine(r.config.goal, 240),
      status: r.status,
      phase: r.phase,
      cycle: r.cycle,
      createdAt: r.createdAt,
      updatedAt: this.now(),
      spendUsd: r.spend.usd,
      leads: r.config.leads,
      goalReached: r.goalReached,
      branchedFrom: r.branchedFrom?.runId,
    };
  }

  // ---------- transcripts ----------
  msgs(taskId: string): Msg[] {
    let t = this.transcripts.get(taskId);
    if (!t) {
      t = this.store.loadMsgs(taskId);
      this.transcripts.set(taskId, t);
    }
    return t;
  }

  appendMsgs(task: Task, ...add: Msg[]): void {
    const t = this.msgs(task.id);
    const from = t.length;
    t.push(...add);
    this.msgFrom.set(task.id, Math.min(this.msgFrom.get(task.id) ?? from, from));
    task.msgCount = t.length;
    this.put("task", task);
  }

  replaceMsgs(task: Task, all: Msg[]): void {
    this.transcripts.set(task.id, all);
    this.msgFrom.set(task.id, 0);
    task.msgCount = all.length;
    this.put("task", task);
  }

  /** Drops a finished task's transcript from memory once it is written. */
  release_transcript(taskId: string): void {
    this.evict.add(taskId);
  }

  transcript(taskId: string): { task: Task; msgs: Msg[] } | null {
    const task = this.m.task.get(taskId);
    if (!task) return null;
    const src = this.transcripts.get(taskId) ?? this.store.loadMsgs(taskId);
    return { task, msgs: src.map((x) => (x.role === "assistant" ? { ...x, raw: [] } : x)) };
  }

  // ---------- who is taking part ----------
  activeLeads(): Agent[] {
    const order = this.run.config.leads;
    return this.all("agent")
      .filter((a) => a.kind === "lead" && a.active)
      .sort((a, b) => order.indexOf(a.model) - order.indexOf(b.model));
  }

  mode(): Mode {
    return this.activeLeads().length < 2 ? "individual" : this.run.config.mode;
  }

  effectiveStandard(): Label {
    const std = this.run.config.standard;
    return this.mode() === "individual" && labelRank(std) > labelRank("candidate") ? "candidate" : std;
  }

  /** Makes the lead agents match the configured lead models. */
  syncLeads(): void {
    const now = this.now();
    const want = this.run.config.leads;
    for (const key of want) {
      const id = `lead-${key}`;
      const cur = this.m.agent.get(id);
      if (cur) {
        if (!cur.active) {
          cur.active = true;
          this.put("agent", cur);
          this.event("info", "agent", `${cur.name} rejoined as a lead.`, id);
        }
        continue;
      }
      this.put("agent", { id, kind: "lead", model: key, name: MODELS[key].short, role: "Lead researcher", team: id, depth: 0, status: "idle", createdAt: now, usage: zeroUsage(), costUsd: 0, turns: 0, active: true });
      if (this.run.status !== "draft") this.event("info", "agent", `${MODELS[key].short} joined as a lead and takes part from the current phase.`, id);
    }
    for (const a of this.all("agent")) {
      if (a.kind !== "lead" || !a.active || want.includes(a.model)) continue;
      a.active = false;
      a.status = "idle";
      this.put("agent", a);
      for (const t of this.all("task")) if (t.agentId === a.id && !TERMINAL.has(t.status)) this.cancelTask(t, "The lead was removed from the run.");
      for (const d of this.all("agent")) if (d.parentId === a.id) this.cancelAgent(d.id, "Its lead was removed from the run.");
      this.event("warn", "agent", `${a.name} was removed as a lead. What it recorded stays in the ledger.`, a.id);
    }
  }

  canSee(agent: Agent, item: { team: string; cycle: number; phase?: Phase }): boolean {
    if (item.team === agent.team) return true;
    const mode = this.mode();
    if (mode === "individual") return false;
    const p = this.run.phase;
    const blind = p === "understand" || p === "prior_work" || p === "work";
    return !(blind && item.cycle === this.run.cycle && (mode === "debate" || this.run.cycle === 1));
  }

  canSeeRef(agent: Agent, ref: string, task?: Task): boolean {
    const allow = task?.type === "subagent_review" ? ((task.input.allow as string[] | undefined) ?? []) : [];
    if (allow.includes(ref)) return true;
    const viaClaim = (claimId: string | undefined): boolean => {
      if (!claimId || allow.includes(claimId)) return true;
      const c = this.m.claim.get(claimId);
      return !c || this.canSee(agent, c);
    };
    if (/^(sub|lead)-/.test(ref)) {
      const a = this.m.agent.get(ref);
      if (!a || a.team === agent.team) return true;
      if (this.mode() === "individual") return false;
      return a.kind === "lead" || this.canSee(agent, { team: a.team, cycle: this.taskOf(a.id)?.cycle ?? this.run.cycle });
    }
    switch (ref[0]) {
      case "C":
        return viaClaim(ref);
      case "V":
        return viaClaim(this.m.evidence.get(ref)?.claimId);
      case "O":
        return viaClaim(this.m.obligation.get(ref)?.claimId);
      case "X":
        return viaClaim(this.m.objection.get(ref)?.claimId);
      case "R":
        return viaClaim(this.m.review.get(ref)?.claimId);
      case "L":
        return viaClaim(this.m.leancheck.get(ref)?.claimId);
      case "E": {
        const x = this.m.experiment.get(ref);
        return !x || this.canSee(agent, x);
      }
      case "N": {
        const n = this.m.note.get(ref);
        return !n || this.canSee(agent, n);
      }
      case "A": {
        const by = this.m.agent.get(this.m.artifact.get(ref)?.byAgent ?? "");
        return !by || this.canSee(agent, { team: by.team, cycle: this.run.cycle });
      }
      default:
        return true;
    }
  }

  // ---------- ledger ----------
  ledgerCtx(): LedgerCtx {
    const group = <T extends { claimId: string }>(items: T[]): Map<string, T[]> => {
      const map = new Map<string, T[]>();
      for (const it of items) {
        const cur = map.get(it.claimId);
        if (cur) cur.push(it);
        else map.set(it.claimId, [it]);
      }
      return map;
    };
    const ev = group(this.all("evidence"));
    const ob = group(this.all("obligation"));
    const oj = group(this.all("objection"));
    const rv = group(this.all("review"));
    const lc = group(this.all("leancheck"));
    return {
      mode: this.mode(),
      leads: this.activeLeads(),
      claim: (id) => this.m.claim.get(id),
      evidenceOf: (id) => ev.get(id) ?? [],
      obligationsOf: (id) => ob.get(id) ?? [],
      objectionsOf: (id) => oj.get(id) ?? [],
      reviewsOf: (id) => rv.get(id) ?? [],
      leanChecksOf: (id) => lc.get(id) ?? [],
      experiment: (id) => this.m.experiment.get(id),
    };
  }

  /** Recomputes every claim's label from the evidence until nothing changes. Returns the claims newly invalidated. */
  reassess(): string[] {
    const ctx = this.ledgerCtx();
    const hit: string[] = [];
    for (let pass = 0; pass < 60; pass++) {
      let changed = false;
      for (const c of this.m.claim.values()) {
        const a = assess(c, ctx);
        if (a.label === c.label && a.stale === c.stale && (a.staleReason ?? "") === (c.staleReason ?? "") && a.blockers.join("\n") === c.blockers.join("\n")) continue;
        if (a.stale && !c.stale) hit.push(c.id);
        c.label = a.label;
        c.blockers = a.blockers;
        c.stale = a.stale;
        c.staleReason = a.staleReason;
        this.put("claim", c);
        changed = true;
      }
      if (!changed) break;
    }
    const uniq = [...new Set(hit)];
    for (const id of uniq) this.event("warn", "invalidated", `${id} is invalidated: ${this.m.claim.get(id)?.staleReason ?? "a claim it depends on no longer stands"}.`, undefined, id);
    return uniq;
  }

  goalState(): GoalStatus {
    return goalStatus(this.all("claim"), this.effectiveStandard(), this.ledgerCtx());
  }

  reviewQueue(leadId: string): Claim[] {
    const lead = this.m.agent.get(leadId);
    if (!lead || this.mode() === "individual") return [];
    const mine = new Set(
      this.all("review")
        .filter((r) => r.byAgent === leadId)
        .map((r) => `${r.claimId}@${r.revision}`),
    );
    return this.all("claim")
      .filter((c) => c.status === "active" && !c.stale && c.team !== lead.team && (c.answersGoal || labelRank(c.label) >= labelRank("numerical")) && this.canSee(lead, c) && !mine.has(`${c.id}@${c.revision}`))
      .sort((a, b) => Number(b.answersGoal) - Number(a.answersGoal) || labelRank(b.label) - labelRank(a.label) || a.createdAt - b.createdAt);
  }

  // ---------- sources and search ----------
  index(ref: string, kind: string, title: string, body: string): void {
    this.store.indexDoc(ref, kind, title, body.length > 1_000_000 ? body.slice(0, 1_000_000) : body);
  }

  indexClaim(c: Claim): void {
    this.index(c.id, "claim", oneLine(c.statement, 200), `${c.statement}\n\n${c.argument}`);
  }

  /** Rebuilds the search index from the stored records, after the run's database was put back from the permanent store. */
  reindex(): void {
    for (const c of this.m.claim.values()) this.indexClaim(c);
    for (const src of this.m.source.values()) this.index(src.id, "source", src.title, this.sourceText(src.id) || src.title);
    for (const i of this.m.instruction.values()) this.index(i.id, "instruction", "Instruction from the user", i.text);
  }

  sourceText(id: string): string {
    return this.store.getText(`src:${id}`) ?? "";
  }

  /** Registers a retrieved document. Bibliographic fields come only from the retrieval API; an existing record is never overwritten by a model. */
  addSource(meta: SourceMeta, body: string, byAgent?: string, updateId?: string): Source {
    let src = updateId ? this.m.source.get(updateId) : undefined;
    if (!src) {
      src = this.all("source").find(
        (s) =>
          (!!meta.doi && !!s.doi && s.doi.toLowerCase() === meta.doi.toLowerCase()) ||
          (!!meta.arxivId && s.arxivId === meta.arxivId) ||
          (!!meta.url && !!s.url && normUrl(s.url) === normUrl(meta.url)) ||
          (!!meta.uploadId && s.uploadId === meta.uploadId),
      );
    }
    if (!src) {
      src = {
        id: this.id("S"),
        kind: meta.kind,
        title: clip(meta.title || meta.url || "Untitled", 400),
        url: meta.url,
        authors: meta.authors.slice(0, 40),
        date: meta.date,
        venue: meta.venue,
        doi: meta.doi,
        arxivId: meta.arxivId,
        via: meta.via,
        retrievedAt: this.now(),
        byAgent,
        textChars: 0,
        textComplete: false,
        snippet: "",
        uploadId: meta.uploadId,
      };
    } else {
      if (!src.authors.length && meta.authors.length) src.authors = meta.authors.slice(0, 40);
      src.date ??= meta.date;
      src.venue ??= meta.venue;
      src.doi ??= meta.doi;
      src.arxivId ??= meta.arxivId;
      src.url ??= meta.url;
    }
    const held = src.textChars ? this.sourceText(src.id) : "";
    const next = (body ?? "").slice(0, MAX_SOURCE_CHARS);
    if (next.length > held.length) {
      this.store.putText(`src:${src.id}`, next);
      src.textChars = next.length;
      src.textComplete = !!meta.complete;
      src.snippet = oneLine(next, 280);
      this.index(src.id, "source", src.title, next);
    } else if (!held.length) {
      this.index(src.id, "source", src.title, src.title);
    }
    this.put("source", src);
    return src;
  }

  search(query: string, limit = 30, kinds?: string[]): SearchHit[] {
    return this.store.search(query, Math.min(Math.max(1, limit), 100), kinds);
  }

  /** Text held for a source, for the viewer. */
  text(ref: string): string | null {
    return /^S\d+$/.test(ref) ? this.store.getText(`src:${ref}`) : null;
  }

  calls(): CallRecord[] {
    return this.all("call").sort((a, b) => a.at - b.at);
  }

  // ---------- money ----------
  budgetLeft(): number {
    const s = this.run.spend;
    return this.run.config.limits.spendUsd - s.usd - s.reservedUsd;
  }

  reserve(usd: number): boolean {
    if (usd > this.budgetLeft() + 1e-9) return false;
    this.run.spend.reservedUsd += usd;
    this.touch();
    return true;
  }

  release(usd: number): void {
    const left = this.run.spend.reservedUsd - usd;
    // Sums of floats leave a residue; a hold below a hundredth of a cent is no hold.
    this.run.spend.reservedUsd = left < 1e-6 ? 0 : left;
    this.touch();
  }

  charge(task: Task, agent: Agent, _model: ModelKey, usage: Usage, costUsd: number): void {
    const s = this.run.spend;
    s.usd += costUsd;
    s.usage = addUsage(s.usage, usage);
    task.costUsd += costUsd;
    task.usage = addUsage(task.usage, usage);
    agent.costUsd += costUsd;
    agent.usage = addUsage(agent.usage, usage);
    this.put("task", task);
    this.put("agent", agent);
    this.touch();
  }

  recordCall(c: Omit<CallRecord, "id" | "at" | "gatewayModel">): string {
    const rec: CallRecord = { ...c, id: this.id("Q"), at: this.now(), gatewayModel: MODELS[c.model].id };
    this.put("call", rec);
    this.run.spend.calls++;
    this.touch();
    return rec.id;
  }

  // ---------- tools ----------
  toolOk(name: ToolName): boolean {
    return this.run.config.tools[name] === true && this.run.toolStatus[name]?.ok !== false;
  }

  /** Three infrastructure failures in a row switch a tool off, so models stop planning around it. */
  noteInfra(tool: "sandbox" | "sage" | "lean", ok: boolean, detail?: string): void {
    const key = `infra_${tool}`;
    if (ok) {
      if (this.run.counters[key]) {
        this.run.counters[key] = 0;
        this.touch();
      }
      return;
    }
    const n = (this.run.counters[key] ?? 0) + 1;
    this.run.counters[key] = n;
    if (n >= 3 && this.run.toolStatus[tool]?.ok !== false) {
      this.run.toolStatus[tool] = { ok: false, detail: `Switched off after ${n} infrastructure failures in a row. Last: ${oneLine(detail ?? "no detail", 300)}`, checkedAt: this.now() };
      this.event("warn", "tool", `${tool} was switched off after ${n} infrastructure failures in a row: ${oneLine(detail ?? "", 200)}`);
    }
    this.touch();
  }

  /** Checks the configured retrieval and verification services and records what is really available. */
  async preflight(only?: (name: string) => boolean): Promise<void> {
    const cfg = this.run.config.tools;
    const names = PREFLIGHT_TOOLS.filter((n) => cfg[n] && (!only || only(n)));
    const res = await Promise.all(
      names.map(async (n) => {
        try {
          return await this.services.preflight(n);
        } catch (e) {
          return { ok: false, detail: errText(e), checkedAt: this.now() };
        }
      }),
    );
    names.forEach((n, i) => {
      const was = this.run.toolStatus[n];
      this.run.toolStatus[n] = res[i];
      if (res[i].ok) this.run.counters[`infra_${n}`] = 0;
      if (!res[i].ok && was?.ok !== false) this.event("warn", "tool", `${n} is not available: ${oneLine(res[i].detail, 240)}`);
      if (res[i].ok && was && !was.ok) this.event("info", "tool", `${n} is available again.`);
    });
    this.touch();
  }

  // ---------- subagents ----------
  subagentCap(): number {
    return Math.min(this.run.config.limits.subagentCap, SUBAGENT_HARD_CAP);
  }

  canDelegate(agent: Agent): boolean {
    return agent.depth < Math.min(this.run.config.limits.maxDepth, DEPTH_HARD_CAP) && this.subagentCap() > 0;
  }

  taskOf(agentId: string): Task | undefined {
    for (const t of this.m.task.values()) if (t.agentId === agentId && t.type === "subagent") return t;
    return undefined;
  }

  descendants(agentId: string): Agent[] {
    const out: Agent[] = [];
    const agents = this.all("agent");
    const walk = (id: string): void => {
      for (const a of agents) {
        if (a.parentId !== id) continue;
        out.push(a);
        walk(a.id);
      }
    };
    walk(agentId);
    return out;
  }

  /** Direct children that are still at work, or finished but not yet reviewed by another model. */
  pendingChildren(agentId: string): Agent[] {
    return this.all("agent").filter((a) => a.parentId === agentId && !this.awaitReady(a));
  }

  awaitReady(a: Agent): boolean {
    if (!AGENT_TERMINAL.has(a.status)) return false;
    return a.status !== "completed" || !!a.review || !!a.reviewNote;
  }

  recount(): void {
    const c = { created: 0, running: 0, queued: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const a of this.m.agent.values()) {
      if (a.kind !== "subagent") continue;
      c.created++;
      if (a.status === "running" || a.status === "waiting") c.running++;
      else if (a.status === "queued" || a.status === "idle") c.queued++;
      else c[a.status]++;
    }
    const cur = this.run.subagents;
    if (JSON.stringify(cur) === JSON.stringify(c)) return;
    this.run.subagents = c;
    this.touch();
  }

  /**
   * Creates subagents. Synchronous on purpose: the cap check and the creation cannot be interleaved with
   * another lead's request, so the run can never hold more than the cap.
   */
  spawn(parent: Agent, specs: SpawnSpec[]): { created: Agent[]; text: string } {
    const cfg = this.run.config;
    const cap = this.subagentCap();
    const created: Agent[] = [];
    if (!this.canDelegate(parent)) return { created, text: "Delegation is not available to you: the depth limit is reached or subagents are switched off for this run." };
    const lead = this.m.agent.get(parent.team);
    const leadModel = lead?.model ?? parent.model;
    const byIndex: (string | undefined)[] = [];
    const lines: string[] = [];
    const now = this.now();
    specs.forEach((sp, i) => {
      const n = i + 1;
      const dup = this.all("agent").find((a) => a.kind === "subagent" && a.team === parent.team && a.status !== "failed" && a.status !== "cancelled" && similarity(a.assignment?.question ?? "", sp.question) >= 0.85);
      if (dup) {
        byIndex[i] = dup.id;
        lines.push(`#${n}: not created — ${dup.id} already has this question (${dup.status}). Use its result.`);
        return;
      }
      const count = this.all("agent").filter((a) => a.kind === "subagent").length;
      if (count >= cap) {
        lines.push(`#${n}: not created — the run's limit of ${cap} subagents is reached (${count} created). Do this piece yourself or drop it.`);
        return;
      }
      const deps: string[] = [];
      let bad = "";
      for (const raw of sp.dependsOn) {
        const hash = /^#(\d+)$/.exec(raw.trim());
        const depId = hash ? (Number(hash[1]) >= 1 && Number(hash[1]) < n ? byIndex[Number(hash[1]) - 1] : undefined) : normId(raw);
        const dep = depId ? this.m.agent.get(depId) : undefined;
        if (!dep || dep.kind !== "subagent") {
          bad = hash ? `"${raw}" does not point to an earlier entry of this call that exists` : `there is no subagent ${String(depId)}`;
          break;
        }
        if (!deps.includes(dep.id)) deps.push(dep.id);
      }
      if (bad) {
        lines.push(`#${n}: not created — ${bad}.`);
        return;
      }
      const model = sp.model && cfg.subagentModels.includes(sp.model) ? sp.model : cfg.subagentModels.includes(leadModel) ? leadModel : (cfg.subagentModels[0] ?? leadModel);
      const seq = (this.run.counters.sub ?? 0) + 1;
      this.run.counters.sub = seq;
      const id = `sub-${seq}`;
      const agent: Agent = {
        id,
        kind: "subagent",
        model,
        name: `${clip(sp.role, 48)} (${id})`,
        role: sp.role,
        parentId: parent.id,
        team: parent.team,
        depth: parent.depth + 1,
        status: "queued",
        assignment: {
          question: sp.question,
          role: sp.role,
          context: sp.context,
          sources: sp.sources.filter((s) => this.m.source.has(s)),
          expectedOutput: sp.expectedOutput,
          dependencies: deps,
          maxTurns: sp.maxTurns,
          budgetUsd: sp.budgetUsd,
          completionCriteria: sp.completionCriteria,
        },
        createdAt: now,
        usage: zeroUsage(),
        costUsd: 0,
        turns: 0,
        spawnKey: `${parent.id}:${this.run.cycle}`,
        active: true,
      };
      this.put("agent", agent);
      const depTasks = deps.map((d) => this.taskOf(d)?.id).filter((x): x is string => !!x);
      this.put("task", this.newTask("subagent", agent, { title: oneLine(sp.question, 140), deps: depTasks, maxTurns: sp.maxTurns, maxOutput: 24000 }));
      byIndex[i] = id;
      created.push(agent);
      lines.push(`#${n}: ${id} created (${MODELS[model].label}, up to ${sp.maxTurns} turns, about ${fmtUsd(sp.budgetUsd)})${deps.length ? `, starts after ${deps.join(", ")}` : ""}.`);
    });
    this.recount();
    if (created.length) this.event("info", "spawn", `${parent.name} delegated ${created.length} assignment${created.length === 1 ? "" : "s"}: ${created.map((a) => a.id).join(", ")}.`, parent.id);
    const total = this.run.subagents.created;
    lines.push(`Subagents created in this run: ${total} of ${cap}. Each result is reviewed by a different model before you receive it; collect them with await_subagents.`);
    return { created, text: lines.join("\n") };
  }

  newTask(type: TaskType, agent: Agent, o: { title: string; deps?: string[]; maxTurns: number; maxOutput: number; input?: Record<string, unknown>; subjectAgentId?: string }): Task {
    return {
      id: this.id("T"),
      type,
      agentId: agent.id,
      model: agent.model,
      status: "queued",
      cycle: this.run.cycle,
      phase: this.run.phase,
      title: o.title,
      input: o.input ?? {},
      deps: o.deps ?? [],
      attempts: 0,
      createdAt: this.now(),
      turns: 0,
      maxTurns: o.maxTurns,
      nudges: 0,
      reservedUsd: 0,
      costUsd: 0,
      usage: zeroUsage(),
      maxOutput: Math.min(o.maxOutput, MODELS[agent.model].maxOutput),
      msgCount: 0,
      compactions: 0,
      restarts: 0,
      uploadsSeen: 0,
      subjectAgentId: o.subjectAgentId,
    };
  }

  /** Every completed subagent is reviewed by a lead running a different model. */
  scheduleReview(sub: Agent): void {
    const leads = this.activeLeads().filter((l) => l.model !== sub.model);
    if (!leads.length) {
      sub.reviewNote = "No lead running a different model was available, so this result has not been reviewed. Treat it as unreviewed.";
      this.put("agent", sub);
      return;
    }
    const load = (l: Agent): number => this.all("task").filter((t) => t.type === "subagent_review" && t.agentId === l.id && !TERMINAL.has(t.status)).length;
    const pick = [...leads].sort((a, b) => Number(a.team === sub.team) - Number(b.team === sub.team) || load(a) - load(b))[0];
    const r = sub.result;
    const allow = [
      sub.id,
      ...(r?.claimIds ?? []),
      ...(r?.experimentIds ?? []),
      ...this.all("claim")
        .filter((c) => c.authorId === sub.id)
        .map((c) => c.id),
      ...this.all("experiment")
        .filter((x) => x.byAgent === sub.id)
        .map((x) => x.id),
      ...this.all("note")
        .filter((x) => x.byAgent === sub.id)
        .map((x) => x.id),
      ...this.all("artifact")
        .filter((x) => x.byAgent === sub.id)
        .map((x) => x.id),
    ];
    this.put("task", this.newTask("subagent_review", pick, { title: `Review of ${sub.id} by ${pick.name}`, maxTurns: 30, maxOutput: 32000, input: { allow: [...new Set(allow)] }, subjectAgentId: sub.id }));
  }

  cancelTask(t: Task, reason: string): void {
    if (TERMINAL.has(t.status)) return;
    t.status = "cancelled";
    t.error = reason;
    t.endedAt = this.now();
    t.waiting = undefined;
    this.put("task", t);
    this.aborts.get(t.id)?.abort();
    this.release_transcript(t.id);
  }

  /** Stops a subagent and everything below it. Returns how many were stopped. */
  cancelAgent(id: string, reason: string): number {
    const root = this.m.agent.get(id);
    if (!root || root.kind !== "subagent") return 0;
    let stopped = 0;
    for (const a of [root, ...this.descendants(id)]) {
      if (AGENT_TERMINAL.has(a.status)) continue;
      a.status = "cancelled";
      a.error = reason;
      a.endedAt = this.now();
      this.put("agent", a);
      stopped++;
      for (const t of this.all("task")) if ((t.agentId === a.id && t.type === "subagent") || (t.type === "subagent_review" && t.subjectAgentId === a.id)) this.cancelTask(t, reason);
    }
    if (stopped) {
      this.recount();
      this.event("warn", "agent", `${stopped} subagent${stopped === 1 ? "" : "s"} stopped: ${oneLine(reason, 200)}`, id);
    }
    return stopped;
  }

  /** Sets a lead's status from the tasks it currently holds. */
  refreshLead(agentId: string): void {
    const a = this.m.agent.get(agentId);
    if (!a || a.kind !== "lead") return;
    const mine = this.all("task").filter((t) => t.agentId === agentId && !TERMINAL.has(t.status));
    const next: Agent["status"] = mine.some((t) => t.status === "running") ? "running" : mine.some((t) => t.status === "waiting") ? "waiting" : mine.length ? "queued" : "idle";
    if (a.status === next) return;
    a.status = next;
    this.put("agent", a);
  }

  // ---------- instructions ----------
  /** Queued instructions this lead has not received yet, in the user's order. */
  pendingInstructions(agent: Agent): Instruction[] {
    if (agent.kind !== "lead") return [];
    return this.all("instruction")
      .filter((i) => i.status === "queued" && (i.target === "all" || i.target === agent.id) && !i.deliveries.some((d) => d.agentId === agent.id))
      .sort((a, b) => a.order - b.order);
  }

  markDelivered(i: Instruction, agent: Agent, task: Task): void {
    i.deliveries.push({ agentId: agent.id, taskId: task.id, at: this.now() });
    const want = i.target === "all" ? this.activeLeads().map((l) => l.id) : [i.target];
    if (want.every((id) => i.deliveries.some((d) => d.agentId === id))) {
      i.status = "delivered";
      i.deliveredAt = this.now();
    }
    this.put("instruction", i);
    this.event("info", "instruction", `Instruction ${i.id} delivered to ${agent.name}.`, agent.id, i.id);
  }

  addInstruction(body: string, target = "all"): ActionResult & { id?: string } {
    const t = body.trim();
    if (!t) return { ok: false, error: "The instruction is empty." };
    if (target !== "all") {
      const a = this.m.agent.get(target);
      if (!a || a.kind !== "lead" || !a.active) return { ok: false, error: "That lead is not taking part in this run." };
    }
    const order = Math.max(0, ...this.all("instruction").map((i) => i.order)) + 1;
    const i: Instruction = { id: this.id("I"), text: t.slice(0, 8000), target, status: "queued", order, createdAt: this.now(), deliveries: [] };
    this.put("instruction", i);
    this.index(i.id, "instruction", "Instruction from the user", i.text);
    this.event("info", "instruction", `Instruction ${i.id} queued for ${target === "all" ? "all leads" : (this.m.agent.get(target)?.name ?? target)}.`, undefined, i.id);
    this.flush();
    this.kick();
    return { ok: true, id: i.id };
  }

  editInstruction(id: string, body: string): ActionResult {
    const i = this.m.instruction.get(id);
    if (!i) return { ok: false, error: "No such instruction." };
    if (i.status !== "queued" || i.deliveries.length) return { ok: false, error: "This instruction has already reached a lead and can no longer be edited. Send a new one to correct it." };
    if (!body.trim()) return { ok: false, error: "The instruction is empty." };
    i.text = body.trim().slice(0, 8000);
    i.editedAt = this.now();
    this.put("instruction", i);
    this.flush();
    return { ok: true };
  }

  cancelInstruction(id: string): ActionResult {
    const i = this.m.instruction.get(id);
    if (!i) return { ok: false, error: "No such instruction." };
    if (i.status !== "queued") return { ok: false, error: "This instruction is no longer queued." };
    if (i.deliveries.length) return { ok: false, error: "This instruction has already reached a lead. Send a new one to countermand it." };
    i.status = "cancelled";
    this.put("instruction", i);
    this.event("info", "instruction", `Instruction ${i.id} cancelled before delivery.`, undefined, i.id);
    this.flush();
    return { ok: true };
  }

  reorderInstructions(ids: string[]): ActionResult {
    const queued = this.all("instruction")
      .filter((i) => i.status === "queued")
      .sort((a, b) => a.order - b.order);
    const pos = (i: Instruction): number => (ids.includes(i.id) ? ids.indexOf(i.id) : ids.length + i.order);
    const base = Math.max(0, ...this.all("instruction").map((i) => i.order));
    [...queued]
      .sort((a, b) => pos(a) - pos(b))
      .forEach((i, k) => {
        i.order = base + 1 + k;
        this.put("instruction", i);
      });
    this.flush();
    return { ok: true };
  }

  // ---------- uploads ----------
  async addUpload(f: { name: string; mime: string; bytes: Uint8Array; text?: string; pages?: number }): Promise<ActionResult & { upload?: Upload }> {
    if (!f.bytes.length) return { ok: false, error: "The file is empty." };
    if (f.bytes.length > MAX_UPLOAD_BYTES) return { ok: false, error: `The file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1e6)} MB.` };
    if (this.m.upload.size >= MAX_UPLOADS) return { ok: false, error: `A run holds at most ${MAX_UPLOADS} files.` };
    const sha = await sha256Hex(f.bytes);
    const same = this.all("upload").find((u) => u.sha256 === sha);
    if (same) return { ok: true, upload: same };
    const name = f.name.trim().slice(0, 200) || "file";
    const kind = uploadKind(name, f.mime);
    let body = (f.text ?? "").trim();
    if (!body && kind === "text") body = new TextDecoder().decode(f.bytes).trim();
    const up: Upload = { id: this.id("U"), name, mime: f.mime || "application/octet-stream", size: f.bytes.length, kind, pages: f.pages, textChars: body.length, sha256: sha, addedAt: this.now() };
    this.store.putBlob(`up:${up.id}`, f.bytes);
    if (body) {
      const src = this.addSource({ kind: "upload", title: name, authors: [], via: "uploaded by the user", complete: true, uploadId: up.id }, body);
      up.sourceId = src.id;
      up.textChars = src.textChars;
    }
    this.put("upload", up);
    this.event("info", "upload", `The user added "${name}" (${kind}${up.sourceId ? `, text held as ${up.sourceId}` : ", no text extracted"}).`, undefined, up.id);
    this.flush();
    this.kick();
    return { ok: true, upload: up };
  }

  uploadBytes(id: string): Uint8Array | null {
    return this.m.upload.has(id) ? this.store.getBlob(`up:${id}`) : null;
  }

  // ---------- run control ----------
  private accrue(): void {
    const now = this.now();
    const r = this.run;
    if (r.status === "running" && r.lastTickAt !== undefined) r.activeMs += Math.max(0, Math.min(now - r.lastTickAt, 90000));
    r.lastTickAt = now;
    this.touch();
  }

  /** Stops scheduling new work and tells the user why. Steps already in flight finish their current turn. */
  pauseRun(reason: string, alert: boolean): void {
    if (this.run.status !== "running") return;
    this.accrue();
    this.run.status = "paused";
    this.run.pauseReason = reason;
    this.run.outcome = reason;
    this.event("warn", "run", `Paused: ${reason}`);
    checkpoint(this, "paused");
    if (alert) notify(this, "attention");
  }

  /** An unrecoverable problem: the run stops scheduling work and asks for the user. */
  attention(reason: string): void {
    if (this.run.status !== "running") return;
    this.accrue();
    this.run.status = "needs_attention";
    this.run.error = reason;
    this.run.outcome = reason;
    this.event("error", "run", `The run needs your attention: ${reason}`);
    checkpoint(this, "needs attention");
    notify(this, "attention");
  }

  async action(kind: "start" | "pause" | "resume" | "stop"): Promise<ActionResult> {
    if (kind === "start" || kind === "resume") await this.syncMethod(true);
    const r = this.run;
    const cfg = r.config;
    if (kind === "start" || kind === "resume") {
      if (kind === "start" && r.status !== "draft") return { ok: false, error: "This run has already been started." };
      if (kind === "resume" && (r.status === "draft" || r.status === "running")) return { ok: false, error: r.status === "draft" ? "This run has not been started yet." : "The run is already running." };
      if (!cfg.goal.trim()) return { ok: false, error: "The run has no goal." };
      if (!this.activeLeads().length) return { ok: false, error: "The run has no lead model." };
      if (r.spend.usd >= cfg.limits.spendUsd) return { ok: false, error: `The spend limit of ${fmtUsd(cfg.limits.spendUsd)} is already used up. Raise it first.` };
      if (!cfg.limits.untilSpend && r.activeMs >= cfg.limits.runtimeMin * 60000) return { ok: false, error: `The runtime limit of ${cfg.limits.runtimeMin} minutes is already used up. Raise it first.` };
      await this.preflight();
      if (cfg.standard === "formal" && !this.toolOk("lean")) {
        this.flush();
        return {
          ok: false,
          error: `The standard "Formally checked theorem" needs a working Lean checker, and none is available${cfg.tools.lean ? `: ${this.run.toolStatus.lean?.detail ?? "unknown reason"}` : " (Lean is switched off for this run)"}. Configure a Lean server in Settings, or choose a lower standard.`,
        };
      }
      const now = this.now();
      if (kind === "start") {
        r.startedAt = now;
        r.cycle += 1;
        r.phase = r.cycle === 1 ? "understand" : "work";
      } else {
        prepareResume(this);
      }
      r.status = "running";
      r.pauseReason = undefined;
      r.error = undefined;
      r.outcome = undefined;
      r.endedAt = undefined;
      r.lastTickAt = now;
      r.nextDigestAt = now + cfg.alerts.intervalMin * 60000;
      this.touch();
      this.event("info", "run", kind === "start" ? `Run started in ${this.mode()} mode with ${this.activeLeads().map((l) => l.name).join(", ")}.` : "Run resumed.");
      this.tickSync();
      await this.schedule();
      return { ok: true };
    }
    if (kind === "pause") {
      if (r.status !== "running") return { ok: false, error: "The run is not running." };
      this.pauseRun("Paused by you. Turns already in flight are finishing.", false);
      this.flush();
      return { ok: true };
    }
    if (r.status === "draft" || r.status === "stopped" || r.status === "completed") return { ok: false, error: "There is nothing to stop." };
    this.accrue();
    r.status = "stopped";
    r.endedAt = this.now();
    r.outcome = "Stopped by you.";
    r.pauseReason = undefined;
    for (const t of this.all("task")) this.cancelTask(t, "The run was stopped.");
    for (const a of this.all("agent")) {
      if (a.kind === "subagent" && !AGENT_TERMINAL.has(a.status)) {
        a.status = "cancelled";
        a.error = "The run was stopped.";
        a.endedAt = this.now();
        this.put("agent", a);
      } else if (a.kind === "lead" && a.status !== "idle") {
        a.status = "idle";
        this.put("agent", a);
      }
    }
    this.recount();
    this.event("warn", "run", "Run stopped by the user. Everything recorded so far is kept.");
    checkpoint(this, "stopped");
    this.tickSync();
    await this.schedule();
    return { ok: true };
  }

  updateConfig(patch: unknown): ActionResult {
    const r = this.run;
    const before = r.config;
    const next = sanitizeConfig(patch, before);
    if (r.status !== "draft") {
      next.goal = before.goal;
      if (!next.title) next.title = before.title;
    }
    if (!next.goal.trim() && r.status !== "draft") return { ok: false, error: "The goal cannot be removed." };
    r.config = next;
    this.touch();
    this.syncLeads();
    this.reassess();
    const changes: string[] = [];
    if (before.mode !== next.mode) changes.push(`mode ${before.mode} → ${next.mode}`);
    if (before.speed !== next.speed) changes.push(`speed ${before.speed} → ${next.speed}`);
    if (before.standard !== next.standard) changes.push(`standard → ${next.standard}`);
    if (before.leads.join() !== next.leads.join()) changes.push(`leads → ${next.leads.map((k) => MODELS[k].short).join(", ")}`);
    if (JSON.stringify(before.limits) !== JSON.stringify(next.limits)) changes.push("limits");
    if (JSON.stringify(before.tools) !== JSON.stringify(next.tools)) changes.push("tools");
    if (JSON.stringify(before.alerts) !== JSON.stringify(next.alerts)) {
      changes.push("alerts");
      if (r.status === "running") r.nextDigestAt = this.now() + next.alerts.intervalMin * 60000;
    }
    if (r.status !== "draft" && changes.length) this.event("info", "config", `Settings changed: ${changes.join("; ")}.`);
    this.flush();
    this.kick();
    return { ok: true };
  }

  // ---------- exports ----------
  export(format: "md" | "tex" | "json"): { filename: string; mime: string; content: string } {
    const title = this.run.config.title || "Scholium run";
    const base =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "scholium-run";
    if (format === "json") {
      const s = this.publicSnapshot();
      return { filename: `${base}.json`, mime: "application/json", content: JSON.stringify({ exportedAt: new Date(this.now()).toISOString(), ...s, calls: this.calls() }, null, 2) };
    }
    const md = buildReport(dataFrom(this.snapshot()), { now: this.now(), full: true });
    if (format === "tex") return { filename: `${base}.tex`, mime: "application/x-tex", content: toLatex(md, title) };
    return { filename: `${base}.md`, mime: "text/markdown", content: md };
  }

  exportCheckpoint(id: string): CheckpointExport | null {
    return exportCheckpoint(this, id);
  }

  /** Copies a source text into a branch. */
  importText(sourceId: string, body: string): void {
    const src = this.m.source.get(sourceId);
    if (!src || !body) return;
    this.store.putText(`src:${sourceId}`, body);
    this.index(sourceId, "source", src.title, body);
  }

  importBlob(uploadId: string, bytes: Uint8Array): void {
    if (this.m.upload.has(uploadId)) this.store.putBlob(`up:${uploadId}`, bytes);
  }

  // ---------- driving ----------
  /** Asks the host to tick the engine again right away. */
  kick(): void {
    void Promise.resolve()
      .then(() => this.hooks.wake(0))
      .catch(() => undefined);
  }

  /** Runs a background job once per key at a time. */
  track(key: string, fn: () => Promise<void>): void {
    if (this.jobs.has(key)) return;
    const p = fn()
      .catch((e) => this.event("warn", "background", `Background job ${key} failed: ${errText(e)}`))
      .then(() => {
        this.jobs.delete(key);
        this.flush();
      });
    this.jobs.set(key, p);
  }

  private limits(): void {
    const r = this.run;
    const l = r.config.limits;
    if (!l.untilSpend && r.activeMs >= l.runtimeMin * 60000) return this.pauseRun(`The runtime limit of ${l.runtimeMin} minutes is reached. Raise it and resume to continue.`, true);
    if (r.spend.usd >= l.spendUsd) return this.pauseRun(`The spend limit of ${fmtUsd(l.spendUsd)} is reached. Raise it and resume to continue.`, true);
  }

  private depsDone(t: Task): boolean {
    return t.deps.every((d) => {
      const dep = this.m.task.get(d);
      return !dep || TERMINAL.has(dep.status);
    });
  }

  private candidates(now: number): Task[] {
    return this.all("task")
      .filter((t) => (t.status === "queued" || t.status === "running") && !this.inFlight.has(t.id) && (t.notBefore ?? 0) <= now && this.depsDone(t))
      .sort((a, b) => (PRIORITY[a.type] ?? 2) - (PRIORITY[b.type] ?? 2) || a.createdAt - b.createdAt);
  }

  private dispatch(): void {
    this.moreToStart = false;
    if (this.run.status !== "running") return;
    const limit = SPEED_CONCURRENCY[this.run.config.speed];
    const cands = this.candidates(this.now());
    let started = 0;
    let unaffordable = 0;
    for (const t of cands) {
      if (this.inFlight.size >= limit) break;
      if (started >= this.opts.maxStartsPerTick) {
        this.moreToStart = true;
        break;
      }
      const known = typeof t.input.ctxTokens === "number" ? t.input.ctxTokens : 0;
      const hold = worstCaseCost(t.model, Math.max(known, estTokens(60000)) + 4000, t.maxOutput);
      if (!this.reserve(hold)) {
        unaffordable++;
        continue;
      }
      t.reservedUsd = hold;
      this.put("task", t);
      started++;
      const p = runStep(this, t).then(() => {
        this.inFlight.delete(t.id);
        this.kick();
      });
      this.inFlight.set(t.id, p);
    }
    if (unaffordable && !this.inFlight.size) {
      const l = this.run.config.limits;
      this.pauseRun(`What is left of the spend limit (${fmtUsd(this.budgetLeft())} of ${fmtUsd(l.spendUsd)}) does not cover the next model call. Raise the limit and resume to continue.`, true);
    }
  }

  /** One synchronous pass: account for time, enforce limits, move the phases on, start what can start. */
  tickSync(): void {
    if (!this.loaded) return;
    try {
      if (this.run.status === "running") {
        this.accrue();
        this.limits();
      }
      resumeWaiting(this);
      advance(this);
      this.dispatch();
      runBackground(this);
    } catch (e) {
      this.event("error", "engine", `Internal error while scheduling: ${errText(e)}`);
      if (this.run.status === "running") this.attention(`The platform hit an internal error while scheduling: ${errText(e)}`);
    }
    this.flush();
  }

  private async schedule(): Promise<void> {
    const now = this.now();
    let delay: number | null = null;
    if (this.run.status === "running") {
      delay = this.moreToStart ? 25 : this.opts.heartbeatMs;
      for (const t of this.m.task.values()) {
        if ((t.status === "queued" || t.status === "running") && !this.inFlight.has(t.id) && t.notBefore && t.notBefore > now) delay = Math.min(delay, t.notBefore - now + 5);
      }
    } else if (this.inFlight.size || this.jobs.size) {
      delay = this.opts.heartbeatMs;
    }
    if (delay !== null) await this.hooks.wake(delay);
  }

  /** Fetches the adopted notes. A failed fetch keeps the last known notes, so a workspace hiccup changes nothing. */
  refreshMethod(force = false): Promise<void> {
    const get = this.services.method;
    if (!get) return Promise.resolve();
    if (this.methodBusy) return this.methodBusy;
    if (!force && this.methodAt && this.now() - this.methodAt < METHOD_REFRESH_MS) return Promise.resolve();
    this.methodAt = this.now();
    this.methodBusy = get
      .call(this.services)
      .then((m) => {
        if (!m || typeof m.version !== "string" || !m.byRole) return;
        if (m.version !== this.method.version) {
          this.event("info", "method", m.version === "base" ? "No working-method notes are active: agents run on the built-in instructions." : `Working-method notes ${m.version} are in use (${m.ids.join(", ")}).`);
        }
        this.method = m;
      })
      .catch(() => undefined)
      .finally(() => {
        this.methodBusy = null;
      });
    return this.methodBusy;
  }

  /** The first fetch after a start or a wake-up is awaited briefly, so no model call misses the adopted notes. */
  private async syncMethod(force = false): Promise<void> {
    if (!this.services.method) return;
    const wait = force || this.methodAt === 0;
    const p = this.refreshMethod(force);
    if (wait) await Promise.race([p, new Promise<void>((r) => setTimeout(r, 2500))]);
  }

  async tick(): Promise<void> {
    await this.syncMethod();
    this.tickSync();
    await this.schedule();
  }

  /** Resolves when no step and no background job is running. Used by tests and by orderly shutdown. */
  async idle(): Promise<void> {
    while (this.inFlight.size || this.jobs.size) await Promise.all([...this.inFlight.values(), ...this.jobs.values()]);
  }

  newLeadTask(type: TaskType, lead: Agent): Task {
    return newLeadTask(this, type, lead);
  }
}
