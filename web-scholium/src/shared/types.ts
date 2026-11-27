import type { ModelKey, Usage } from "./models";

// ---------- Verification ladder ----------
export type Label = "conjecture" | "numerical" | "partial" | "candidate" | "reviewed" | "formal";
export const LABELS: Label[] = ["conjecture", "numerical", "partial", "candidate", "reviewed", "formal"];
export const LABEL_NAMES: Record<Label, string> = {
  conjecture: "Conjecture",
  numerical: "Numerical evidence",
  partial: "Partial result",
  candidate: "Candidate proof",
  reviewed: "Model-reviewed argument",
  formal: "Formally checked theorem",
};
export const labelRank = (l: Label): number => LABELS.indexOf(l);
/** Labels an author may propose. The two highest are granted only by the platform. */
export const AUTHOR_LABELS: Label[] = ["conjecture", "numerical", "partial", "candidate"];

// ---------- Run ----------
export type Mode = "individual" | "collaborative" | "debate";
export type Speed = "medium" | "fast" | "ultrafast" | "hundred" | "swarm";
export const SPEEDS: Speed[] = ["medium", "fast", "ultrafast", "hundred", "swarm"];
export const SPEED_LABEL: Record<Speed, string> = { medium: "Medium", fast: "Fast", ultrafast: "Ultrafast", hundred: "Hundred", swarm: "Swarm" };
export const SPEED_CONCURRENCY: Record<Speed, number> = { medium: 8, fast: 16, ultrafast: 32, hundred: 100, swarm: 300 };
/** The most model calls that ever run side by side, whatever a stored project asks for. */
export const CONCURRENCY_HARD_CAP = 300;
/** The most model calls a run makes itself. Anything beyond is carried by helpers, when the host provides them. */
export const DIRECT_CONCURRENCY = 32;
export type RunStatus = "draft" | "running" | "paused" | "stopped" | "completed" | "failed" | "needs_attention";
export type Phase = "setup" | "understand" | "prior_work" | "work" | "cross_review" | "revise" | "confirm" | "decide" | "report" | "done";
export const PHASE_NAMES: Record<Phase, string> = {
  setup: "Setup",
  understand: "Understand",
  prior_work: "Prior work",
  work: "Approach & execute",
  cross_review: "Cross-review",
  revise: "Respond & revise",
  confirm: "Confirm",
  decide: "Decide",
  report: "Report",
  done: "Done",
};
export type SandboxExecutor = "astra-shell" | "fable-bash";
/** The most subagents one run may ever create. It was 100 until November 2026, then 200, 1000 and 2000 for a short while each. */
export const SUBAGENT_HARD_CAP = 10000;
/** How many levels of handing work down a run may allow. The subagent total still bounds the size of the tree. */
export const DEPTH_HARD_CAP = 5;

export interface RunLimits {
  spendUsd: number;
  runtimeMin: number;
  maxCycles: number;
  /** Keep working until the spending limit is reached: the time and cycle limits are not applied. */
  untilSpend: boolean;
  concurrency: number;
  subagentCap: number;
  maxDepth: number;
}

export interface RunTools {
  web: boolean;
  literature: boolean;
  sandbox: boolean;
  sandboxExecutor: SandboxExecutor;
  sage: boolean;
  lean: boolean;
  oeis: boolean;
}

export interface RunAlerts {
  enabled: boolean;
  intervalMin: number;
  onGoal: boolean;
  onAttention: boolean;
}

export interface RunConfig {
  title: string;
  goal: string;
  /** What counts as done, in the user's words. */
  acceptance: string;
  /** Minimum label the goal claim must reach. */
  standard: Label;
  leads: ModelKey[];
  subagentModels: ModelKey[];
  mode: Mode;
  speed: Speed;
  limits: RunLimits;
  tools: RunTools;
  alerts: RunAlerts;
  drive: boolean;
}

export interface ToolStatus {
  ok: boolean;
  detail: string;
  checkedAt: number;
}

export interface SubagentCounts {
  created: number;
  running: number;
  queued: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface RunState {
  id: string;
  ownerHash: string;
  config: RunConfig;
  status: RunStatus;
  phase: Phase;
  cycle: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Milliseconds spent in the running state. */
  activeMs: number;
  lastTickAt?: number;
  pauseReason?: string;
  error?: string;
  goalReached: boolean;
  goalClaimId?: string;
  /** Next-cycle focus chosen in the decide phase. */
  focus?: string;
  stalledStreak: number;
  /** leadId -> cycle in which it committed its approach. */
  approachCommitted: Record<string, number>;
  subagents: SubagentCounts;
  /** Set once the old limit of 100 subagents has been looked at, so a limit of 100 chosen later is left alone. */
  capRaised?: boolean;
  /** The most a project could have when this one was last opened; missing means 200. A project still at that figure is moved up once when the most goes up. */
  capAt?: number;
  spend: { usd: number; reservedUsd: number; calls: number; usage: Usage };
  toolStatus: Record<string, ToolStatus>;
  counters: Record<string, number>;
  branchedFrom?: { runId: string; checkpointId: string };
  /** Site origin the run was created from, used for links in emails. */
  origin?: string;
  /** Respond/confirm rounds completed in the current cycle. */
  reviseRound: number;
  /** Human-readable reason the run ended or paused. */
  outcome?: string;
  lastDigestAt?: number;
  nextDigestAt?: number;
  driveFolderId?: string;
  driveFolderUrl?: string;
  driveLastSyncAt?: number;
  driveError?: string;
  reportArtifactId?: string;
  seq: number;
}

// ---------- Agents & tasks ----------
export type AgentStatus = "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface Assignment {
  question: string;
  role: string;
  context: string;
  sources: string[];
  expectedOutput: string;
  dependencies: string[];
  maxTurns: number;
  budgetUsd: number;
  completionCriteria: string;
}

export interface SubagentResult {
  answer: string;
  findings: string[];
  claimIds: string[];
  experimentIds: string[];
  unresolved: string[];
  confidence: string;
}

export interface Agent {
  id: string;
  kind: "lead" | "subagent";
  model: ModelKey;
  name: string;
  role: string;
  parentId?: string;
  /** Root lead id. */
  team: string;
  depth: number;
  status: AgentStatus;
  assignment?: Assignment;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  usage: Usage;
  costUsd: number;
  turns: number;
  lastActivity?: string;
  result?: SubagentResult;
  error?: string;
  review?: { byAgent: string; byModel: ModelKey; verdict: "accept" | "accept_with_caveats" | "reject"; issues: string[]; at: number };
  reviewNote?: string;
  spawnKey?: string;
  active: boolean;
}

export type TaskType =
  | "understand"
  | "prior_work"
  | "work"
  | "cross_review"
  | "revise"
  | "confirm"
  | "decide"
  | "report"
  | "subagent"
  | "subagent_review";
export type TaskStatus = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  type: TaskType;
  agentId: string;
  model: ModelKey;
  status: TaskStatus;
  cycle: number;
  phase: Phase;
  title: string;
  input: Record<string, unknown>;
  deps: string[];
  attempts: number;
  notBefore?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  result?: Record<string, unknown>;
  turns: number;
  maxTurns: number;
  nudges: number;
  reservedUsd: number;
  costUsd: number;
  usage: Usage;
  maxOutput: number;
  waiting?: { callId: string; agentIds: string[]; held: ToolResult[]; since: number };
  msgCount: number;
  compactions: number;
  restarts: number;
  /** Number of user uploads this task has been told about. */
  uploadsSeen: number;
  /** Subagent this task reviews. */
  subjectAgentId?: string;
}

// ---------- Transcript ----------
export interface Attachment {
  kind: "image" | "pdf";
  uploadId: string;
  mime: string;
  name: string;
}
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Raw argument text when it could not be parsed as JSON. */
  badJson?: string;
}
export interface ToolResult {
  callId: string;
  name: string;
  output: string;
  isError?: boolean;
}
export type Msg =
  | { role: "user"; text: string; attachments?: Attachment[]; origin?: "system" | "user" | "pack" }
  | { role: "assistant"; text: string; thinking?: string; calls: ToolCall[]; raw: unknown[]; callRef?: string }
  | { role: "tool"; results: ToolResult[] };

// ---------- Ledger ----------
export type ClaimKind = "goal" | "theorem" | "lemma" | "observation" | "counterexample" | "definition" | "other";
export type ClaimStatus = "active" | "refuted" | "withdrawn";
export type Basis = "derived" | "retrieved" | "computed" | "memory";

export interface Claim {
  id: string;
  statement: string;
  kind: ClaimKind;
  authorId: string;
  authorModel: ModelKey;
  team: string;
  proposedLabel: Label;
  label: Label;
  /** Why the label is not higher, computed by the platform. */
  blockers: string[];
  status: ClaimStatus;
  statusReason?: string;
  revision: number;
  argument: string;
  dependsOn: string[];
  /** Revision of each dependency when this claim was last written. */
  depRevisions: Record<string, number>;
  stale: boolean;
  staleReason?: string;
  basis: Basis;
  answersGoal: boolean;
  cycle: number;
  phase: Phase;
  createdAt: number;
  updatedAt: number;
  history: { revision: number; at: number; by: string; note: string }[];
}

export type QuoteStatus = "verified" | "approximate" | "not_found" | "unverifiable";
export type EvidenceKind = "citation" | "experiment" | "argument" | "counterexample" | "formal";

export interface Evidence {
  id: string;
  claimId: string;
  revision: number;
  kind: EvidenceKind;
  stance: "supports" | "contradicts";
  summary: string;
  byAgent: string;
  sourceId?: string;
  quote?: string;
  quoteStatus?: QuoteStatus;
  locator?: string;
  experimentId?: string;
  leanCheckId?: string;
  createdAt: number;
}

export interface Obligation {
  id: string;
  claimId: string;
  text: string;
  status: "open" | "discharged";
  raisedBy: string;
  dischargedBy?: string;
  resolution?: string;
  evidenceIds: string[];
  createdAt: number;
  updatedAt: number;
}

export type ObjectionStatus = "open" | "answered" | "resolved" | "conceded" | "unresolved";
export interface Objection {
  id: string;
  claimId: string;
  revision: number;
  byAgent: string;
  byModel: ModelKey;
  team: string;
  severity: "fatal" | "major" | "minor";
  text: string;
  proposedExperiment?: string;
  experimentId?: string;
  status: ObjectionStatus;
  responses: { by: string; at: number; kind: "response" | "concede" | "resolution"; text: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface Review {
  id: string;
  claimId: string;
  revision: number;
  byAgent: string;
  byModel: ModelKey;
  verdict: "accept" | "reject" | "cannot_assess";
  summary: string;
  citationsAudited: string[];
  recomputed: string[];
  satisfiesGoal: boolean;
  createdAt: number;
}

export interface Source {
  id: string;
  kind: "web" | "paper" | "upload" | "oeis";
  title: string;
  url?: string;
  authors: string[];
  date?: string;
  venue?: string;
  doi?: string;
  arxivId?: string;
  /** Which retrieval API returned the bibliographic data. */
  via: string;
  retrievedAt: number;
  byAgent?: string;
  /** Characters of retrieved text held for quote checking. */
  textChars: number;
  textComplete: boolean;
  snippet: string;
  uploadId?: string;
}

export interface Experiment {
  id: string;
  purpose: string;
  lang: "python" | "bash" | "sage";
  code: string;
  seed?: number;
  status: "ok" | "error" | "timeout" | "infra_error";
  exit?: number;
  stdout: string;
  stderr: string;
  stdoutChars: number;
  fullStdoutSha?: string;
  runtime: string;
  executor: SandboxExecutor | "sagecell";
  executorModel?: string;
  /** command: the sandbox ran exactly this code. transcript: the output passed its in-sandbox checksum. */
  verified: { command: boolean; transcript: boolean };
  byAgent: string;
  team: string;
  cycle: number;
  phase: Phase;
  claimIds: string[];
  costUsd: number;
  ms: number;
  createdAt: number;
  error?: string;
}

export interface LeanCheck {
  id: string;
  claimId: string;
  /** Claim revision the formal statement was written for. */
  revision: number;
  theoremName: string;
  source: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  hasSorry: boolean;
  declaresAxioms: boolean;
  axioms: string[];
  nonStandardAxioms: string[];
  versions: string;
  log: string;
  byAgent: string;
  byModel: ModelKey;
  faithfulness?: { byAgent: string; byModel: ModelKey; faithful: boolean; notes: string; at: number };
  createdAt: number;
}

export interface Artifact {
  id: string;
  title: string;
  kind: "report" | "table" | "code" | "document" | "plot" | "data";
  filename: string;
  content: string;
  byAgent: string;
  claimIds: string[];
  experimentId?: string;
  version: number;
  createdAt: number;
}

export interface Upload {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "pdf" | "image" | "text" | "other";
  pages?: number;
  textChars: number;
  sha256: string;
  sourceId?: string;
  addedAt: number;
}

export interface Instruction {
  id: string;
  text: string;
  /** "all" or a lead agent id. */
  target: string;
  status: "queued" | "delivered" | "cancelled";
  order: number;
  createdAt: number;
  editedAt?: number;
  deliveries: { agentId: string; taskId: string; at: number }[];
  deliveredAt?: number;
}

export interface Checkpoint {
  id: string;
  cycle: number;
  phase: Phase;
  at: number;
  reason: string;
  summary: string;
  counts: Record<string, number>;
  spendUsd: number;
}

export interface Note {
  id: string;
  kind: "note" | "approach" | "understanding" | "prior_work" | "work" | "decision" | "reply" | "proposal" | "system";
  text: string;
  byAgent: string;
  team: string;
  cycle: number;
  phase: Phase;
  claimId?: string;
  createdAt: number;
}

export interface EmailLog {
  id: string;
  kind: "digest" | "goal" | "attention" | "test";
  to: string;
  subject: string;
  status: "sent" | "failed" | "skipped";
  detail?: string;
  at: number;
}

export interface DriveFile {
  id: string;
  name: string;
  fileId?: string;
  hash: string;
  syncedAt?: number;
  error?: string;
}

export interface CallRecord {
  id: string;
  /** Which revision of the working-method notes the agent's instructions carried: "base" or "rN". */
  promptVersion?: string;
  taskId: string;
  agentId: string;
  model: ModelKey;
  gatewayModel: string;
  providerModel?: string;
  purpose: string;
  requested: { effort: string; maxOutput: number; thinking?: string };
  reported: Record<string, string>;
  usage: Usage;
  costUsd: number;
  ms: number;
  status: "ok" | "error";
  httpStatus?: number;
  error?: string;
  stop?: string;
  turn: number;
  attempt: number;
  at: number;
}

export interface EntityMap {
  run: RunState;
  agent: Agent;
  task: Task;
  claim: Claim;
  evidence: Evidence;
  obligation: Obligation;
  objection: Objection;
  review: Review;
  source: Source;
  experiment: Experiment;
  leancheck: LeanCheck;
  artifact: Artifact;
  upload: Upload;
  instruction: Instruction;
  checkpoint: Checkpoint;
  note: Note;
  email: EmailLog;
  drivefile: DriveFile;
  call: CallRecord;
}
export type EntityKind = keyof EntityMap;
export const ENTITY_KINDS: EntityKind[] = [
  "run",
  "agent",
  "task",
  "claim",
  "evidence",
  "obligation",
  "objection",
  "review",
  "source",
  "experiment",
  "leancheck",
  "artifact",
  "upload",
  "instruction",
  "checkpoint",
  "note",
  "email",
  "drivefile",
  "call",
];
/** Kinds captured in a checkpoint snapshot and carried into a branch. */
export const LEDGER_KINDS: EntityKind[] = [
  "claim",
  "evidence",
  "obligation",
  "objection",
  "review",
  "source",
  "experiment",
  "leancheck",
  "artifact",
  "upload",
  "note",
  "instruction",
];

// ---------- Wire protocol ----------
export interface ActivityEvent {
  seq: number;
  at: number;
  level: "info" | "warn" | "error" | "success";
  type: string;
  text: string;
  agentId?: string;
  ref?: string;
}

export type Snapshot = { [K in EntityKind]?: EntityMap[K][] };

export type ServerMsg =
  | { t: "snapshot"; entities: Snapshot; events: ActivityEvent[] }
  | { t: "put"; kind: EntityKind; id: string; data: unknown }
  | { t: "batch"; items: { kind: EntityKind; id: string; data: unknown }[] }
  /** An entity too large for one live message: the viewer fetches it over the API instead. */
  | { t: "big"; kind: EntityKind; id: string }
  | { t: "del"; kind: EntityKind; id: string }
  | { t: "event"; event: ActivityEvent }
  | { t: "delta"; taskId: string; agentId: string; kind: "text" | "thinking"; text: string }
  | { t: "ready" }
  | { t: "error"; message: string };

export interface RunSummary {
  id: string;
  title: string;
  goal: string;
  status: RunStatus;
  phase: Phase;
  cycle: number;
  createdAt: number;
  updatedAt: number;
  spendUsd: number;
  leads: ModelKey[];
  goalReached: boolean;
  branchedFrom?: string;
}

export interface PublicSettings {
  /** Which Rork account serves the model calls: this project's own, or another one set with MODEL_ACCOUNT_KEY. The key itself is never sent. */
  modelAccount?: "project" | "other";
  exaKeySet: boolean;
  exaKeyHint?: string;
  /** The user has confirmed their Exa plan is free and cannot bill them. Exa is never called without this. */
  exaFreeConfirmed?: boolean;
  exaEnabled?: boolean;
  exaMonthlyCap?: number;
  exaUsedThisMonth?: number;
  monthlyCapUsd?: number;
  leanUrl: string;
  email: { configured: boolean; recipient?: string };
  drive: { configured: boolean; connected: boolean; email?: string; redirectUri: string; folderUrl?: string };
}

export interface StrategyVersion {
  id: string;
  /** 0 is the built-in baseline with no additions. */
  n: number;
  at: number;
  status: "proposed" | "evaluated" | "adopted" | "rejected" | "rolled_back" | "needs_review";
  /** Which part of the working method this changes. Never app code, security, permissions, credentials, or limits. */
  area: "lead" | "subagent" | "reviewer" | "delegation" | "tools" | "retrieval";
  title: string;
  text: string;
  reason: string;
  proposedBy: string;
  lint: { ok: boolean; problems: string[] };
  evaluation?: { at: number; baseline: number; candidate: number; safetyOk: boolean; costUsd: number; detail: string };
  note?: string;
}

export interface StrategyState {
  active: string[];
  versions: StrategyVersion[];
  log: { at: number; action: string; versionId: string; detail: string }[];
}

export interface WorkspaceOverview {
  runs: RunSummary[];
  settings: PublicSettings;
  budget: import("./budget").BudgetView;
  usage: import("./budget").UsageView;
  diagnostics: DiagnosticResult[];
  diagnosticsAt?: number;
  version: string;
  vault?: VaultView;
}

/** Where things stand with the permanent store, which holds an exact copy of every project. */
export interface VaultView {
  on: boolean;
  /** active: this copy of the site does the work. standby: another copy does, and this one changes nothing. */
  mode: "off" | "pending" | "active" | "standby";
  /** The address of the copy that is working. */
  holder?: string;
  /** Changes made here that the store has not confirmed yet. */
  pending: number;
  lastSavedAt?: number;
  error?: string;
  /** Progress of lining the projects up after the work moved to this copy. */
  restore?: { total: number; done: number; failed: number };
}

export interface DiagnosticResult {
  check: string;
  ok: boolean;
  ms: number;
  detail: string;
  requested?: Record<string, string>;
  reported?: Record<string, string>;
}

export function defaultConfig(): RunConfig {
  return {
    title: "",
    goal: "",
    acceptance: "",
    standard: "reviewed",
    leads: ["astra62", "fable52"],
    subagentModels: ["astra62", "fable52"],
    mode: "collaborative",
    speed: "fast",
    limits: { spendUsd: 40, runtimeMin: 240, maxCycles: 6, untilSpend: false, concurrency: 8, subagentCap: SUBAGENT_HARD_CAP, maxDepth: 2 },
    tools: { web: true, literature: true, sandbox: true, sandboxExecutor: "astra-shell", sage: false, lean: false, oeis: true },
    alerts: { enabled: true, intervalMin: 60, onGoal: true, onAttention: true },
    drive: false,
  };
}
