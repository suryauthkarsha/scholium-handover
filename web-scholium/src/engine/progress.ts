// How far a run is toward its goal, read from the ledger alone.
//
// This is a count of steps on the evidence ladder, not a forecast: it says how strong the best
// recorded answer is against the standard the project asks for. It says nothing about how long the
// remaining steps will take, and it can go down when an answer is refuted or invalidated.
import { LABELS, LABEL_NAMES, labelRank, type Agent, type Claim, type Label, type Mode, type Objection, type Review, type RunState } from "../shared/types";
import { goalStatus, type LedgerCtx } from "./ledger";

export interface GoalProgress {
  /** The standard the answer must meet, after the single-lead rule is applied. */
  standard: Label;
  /** One name per step, in order. The last step is the confirmation that ends the investigation. */
  steps: string[];
  /** Steps completed, from 0 to steps.length. */
  done: number;
  /** The server has recorded the goal as reached. */
  reached: boolean;
  /** The answer the bar is measuring, if any. */
  claimId?: string;
  label?: Label;
  /** What the ledger says still stands between that answer and the goal. */
  missing: string[];
}

export interface ProgressData {
  agent: Agent[];
  claim: Claim[];
  objection: Objection[];
  review: Review[];
}

const CONFIRMED = "Confirmed";

export function goalProgress(run: Pick<RunState, "config" | "goalReached" | "goalClaimId">, data: ProgressData): GoalProgress {
  // The same rules the engine applies: one active lead means there is nobody to cross-review.
  const leads = data.agent.filter((a) => a.kind === "lead" && a.active);
  const mode: Mode = leads.length < 2 ? "individual" : run.config.mode;
  const configured = run.config.standard;
  const standard: Label = mode === "individual" && labelRank(configured) > labelRank("candidate") ? "candidate" : configured;
  const top = labelRank(standard);
  const steps = [...LABELS.slice(0, top + 1).map((l) => LABEL_NAMES[l]), CONFIRMED];

  const recorded = run.goalReached && run.goalClaimId ? data.claim.find((c) => c.id === run.goalClaimId) : undefined;
  if (recorded) return { standard, steps, done: steps.length, reached: true, claimId: recorded.id, label: recorded.label, missing: [] };

  const answers = data.claim.filter((c) => c.answersGoal && c.status === "active");
  if (!answers.length) return { standard, steps, done: 0, reached: false, missing: ["No claim has been recorded as answering the goal."] };

  // The strongest answer that still stands. An invalidated answer counts for nothing until it is repaired.
  const standing = answers.filter((c) => !c.stale).sort((a, b) => labelRank(b.label) - labelRank(a.label) || b.updatedAt - a.updatedAt);
  const best = standing[0] ?? [...answers].sort((a, b) => b.updatedAt - a.updatedAt)[0];

  const ctx: LedgerCtx = {
    mode,
    leads,
    claim: (id) => data.claim.find((c) => c.id === id),
    evidenceOf: () => [],
    obligationsOf: () => [],
    objectionsOf: (id) => data.objection.filter((o) => o.claimId === id),
    reviewsOf: (id) => data.review.filter((r) => r.claimId === id),
    leanChecksOf: () => [],
    experiment: () => undefined,
  };
  const g = goalStatus([best], standard, ctx);
  const missing = g.reached ? ["Every condition is met in the ledger. The run records the goal as reached at its next goal check."] : g.why;
  const done = best.stale ? 0 : Math.min(labelRank(best.label), top) + 1;
  return { standard, steps, done, reached: false, claimId: best.id, label: best.label, missing };
}
