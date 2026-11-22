// Deterministic verification rules. Models propose; this file decides what a claim may be called.
import type { Agent, Claim, Evidence, Experiment, Label, LeanCheck, Mode, Objection, Obligation, Review } from "../shared/types";
import { labelRank, LABEL_NAMES } from "../shared/types";

export interface LedgerCtx {
  mode: Mode;
  /** Leads currently taking part in the run. */
  leads: Agent[];
  claim(id: string): Claim | undefined;
  evidenceOf(claimId: string): Evidence[];
  obligationsOf(claimId: string): Obligation[];
  objectionsOf(claimId: string): Objection[];
  reviewsOf(claimId: string): Review[];
  leanChecksOf(claimId: string): LeanCheck[];
  experiment(id: string): Experiment | undefined;
}

export interface Assessment {
  label: Label;
  blockers: string[];
  stale: boolean;
  staleReason?: string;
}

/** An experiment record may back a claim only if it really ran and its transcript passed both integrity checks. */
export function usableExperiment(e: Experiment | undefined): boolean {
  return !!e && e.status === "ok" && e.verified.command && e.verified.transcript;
}

/** Objections that still stand against the current state of a claim. */
export function blockingObjections(claim: Claim, objections: Objection[]): Objection[] {
  return objections.filter(
    (o) => o.status === "open" || o.status === "answered" || o.status === "unresolved" || (o.status === "conceded" && o.revision === claim.revision),
  );
}

/** Every active lead other than the one whose team wrote the claim must review it. */
export function requiredReviewers(claim: Claim, ctx: LedgerCtx): Agent[] {
  return ctx.leads.filter((l) => l.id !== claim.team);
}

export function acceptedBy(claim: Claim, reviews: Review[], leadId: string): Review | undefined {
  return reviews.find((r) => r.byAgent === leadId && r.revision === claim.revision && r.verdict === "accept");
}

export function staleness(claim: Claim, ctx: LedgerCtx): { stale: boolean; reason?: string } {
  for (const depId of claim.dependsOn) {
    const d = ctx.claim(depId);
    if (!d) return { stale: true, reason: `${depId} no longer exists` };
    if (d.status === "refuted") return { stale: true, reason: `${depId} was refuted` };
    if (d.status === "withdrawn") return { stale: true, reason: `${depId} was withdrawn` };
    if (d.stale) return { stale: true, reason: `${depId} is itself invalidated (${d.staleReason ?? "dependency failed"})` };
  }
  return { stale: false };
}

export function assess(claim: Claim, ctx: LedgerCtx): Assessment {
  if (claim.status !== "active") {
    return { label: "conjecture", blockers: [claim.status === "refuted" ? "Refuted." : "Withdrawn by its author."], stale: false };
  }
  const st = staleness(claim, ctx);
  if (st.stale) {
    return {
      label: "conjecture",
      blockers: [`Invalidated: ${st.reason}. It stays a conjecture until it is revised to stand without that dependency.`],
      stale: true,
      staleReason: st.reason,
    };
  }

  const blockers: string[] = [];
  const evidence = ctx.evidenceOf(claim.id).filter((e) => e.revision === claim.revision);
  const supports = evidence.filter((e) => e.stance === "supports");
  const okExp = supports.filter((e) => e.kind === "experiment" && usableExperiment(e.experimentId ? ctx.experiment(e.experimentId) : undefined));
  const okCite = supports.filter((e) => e.kind === "citation" && (e.quoteStatus === "verified" || e.quoteStatus === "approximate"));
  const hasArg = claim.argument.trim().length >= 40;
  const p = labelRank(claim.proposedLabel);

  let label: Label = "conjecture";
  if (p >= labelRank("numerical") && okExp.length) label = "numerical";
  if (p >= labelRank("partial") && claim.basis !== "computed" && (hasArg || okCite.length)) label = "partial";
  if (p >= labelRank("candidate") && claim.basis !== "computed" && hasArg) label = "candidate";

  if (labelRank(label) < p) {
    if (claim.proposedLabel === "numerical") {
      blockers.push("Numerical evidence needs a linked experiment record that ran and passed its integrity checks.");
    } else if (claim.basis === "computed") {
      blockers.push("Its basis is computation. A finite computation is evidence, not a proof, so it cannot rise above Numerical evidence without a written argument.");
      if (!okExp.length) blockers.push("No verified experiment record is linked.");
    } else if (claim.proposedLabel === "candidate") {
      blockers.push("A candidate proof needs the full argument written into the claim.");
    } else {
      blockers.push("A partial result needs a written argument or a retrieved source whose quote was machine-checked.");
    }
  }
  if (label === "conjecture" && claim.basis === "memory" && !okCite.length && !okExp.length) {
    blockers.push("Stated from model memory. Nothing retrieved, computed or derived in this run backs it.");
  }
  if (claim.basis === "retrieved" && !okCite.length) {
    blockers.push("Marked as coming from the literature, but no retrieved source with a machine-checked quote is attached.");
  }

  const objections = ctx.objectionsOf(claim.id);
  const standing = blockingObjections(claim, objections);
  const notFound = evidence.filter((e) => e.kind === "citation" && e.quoteStatus === "not_found");
  const unverifiable = evidence.filter((e) => e.kind === "citation" && e.quoteStatus === "unverifiable");
  if (notFound.length) blockers.push(`Quote not found in the cited source: ${notFound.map((e) => e.id).join(", ")}.`);
  if (unverifiable.length) blockers.push(`Citation could not be checked because the source text was not retrievable: ${unverifiable.map((e) => e.id).join(", ")}. It does not count as support.`);

  for (const depId of claim.dependsOn) {
    const d = ctx.claim(depId);
    if (d && (claim.depRevisions[depId] ?? d.revision) < d.revision) {
      blockers.push(`${depId} was revised after this claim was written. Re-confirm the dependency with revise_claim.`);
    }
  }

  if (label === "candidate") {
    const rb: string[] = [];
    if (ctx.mode === "individual") rb.push("Individual mode has no cross-review, so nothing here can be called model-reviewed.");
    const openObl = ctx.obligationsOf(claim.id).filter((o) => o.status === "open");
    if (openObl.length) rb.push(`Open proof obligation${openObl.length > 1 ? "s" : ""}: ${openObl.map((o) => o.id).join(", ")}.`);
    if (standing.length) rb.push(`Objection${standing.length > 1 ? "s" : ""} still standing: ${standing.map((o) => `${o.id} (${o.status})`).join(", ")}.`);
    if (notFound.length) rb.push("A cited quote was not found in its source.");
    const req = requiredReviewers(claim, ctx);
    const reviews = ctx.reviewsOf(claim.id);
    if (!req.length) rb.push("No other lead is active to review it.");
    const missing = req.filter((l) => !acceptedBy(claim, reviews, l.id));
    if (missing.length) rb.push(`Awaiting an accepting review of revision ${claim.revision} from: ${missing.map((l) => l.name).join(", ")}.`);
    if (req.length && !req.some((l) => l.model !== claim.authorModel)) rb.push("Needs an accepting review from a different model than its author.");
    for (const depId of claim.dependsOn) {
      const d = ctx.claim(depId);
      if (d && labelRank(d.label) < labelRank("reviewed")) rb.push(`Depends on ${depId}, which is only "${LABEL_NAMES[d.label]}".`);
      if (d && (claim.depRevisions[depId] ?? d.revision) < d.revision) rb.push(`Dependency ${depId} changed since this was written.`);
    }
    if (!rb.length) label = "reviewed";
    else blockers.push(...rb);
  }

  const lean = ctx.leanChecksOf(claim.id).filter((l) => l.revision === claim.revision);
  const clean = lean.filter((l) => l.ok && !l.hasSorry && !l.declaresAxioms && l.nonStandardAxioms.length === 0);
  if (lean.length) {
    const faithful = clean.find((l) => l.faithfulness?.faithful === true && l.faithfulness.byModel !== l.byModel);
    if (faithful && !standing.length) {
      label = "formal";
    } else if (clean.length) {
      if (!faithful) blockers.push("Lean accepted a formal statement. A different model must still confirm that it states this same claim.");
      if (standing.length) blockers.push("A standing objection prevents the formal badge.");
    } else {
      const worst = lean[lean.length - 1];
      if (!worst.ok) blockers.push(`The Lean check ${worst.id} failed.`);
      else if (worst.hasSorry) blockers.push(`The Lean file ${worst.id} contains sorry.`);
      else if (worst.declaresAxioms) blockers.push(`The Lean file ${worst.id} declares its own axioms.`);
      else if (worst.nonStandardAxioms.length) blockers.push(`The Lean proof ${worst.id} depends on non-standard axioms: ${worst.nonStandardAxioms.join(", ")}.`);
    }
  }

  return { label, blockers: [...new Set(blockers)], stale: false };
}

export interface GoalStatus {
  reached: boolean;
  claimId?: string;
  /** Why the best candidate does not yet count. */
  why: string[];
}

/** The goal is reached only when a goal claim meets the required standard and every other lead confirmed that it answers the goal. */
export function goalStatus(claims: Claim[], standard: Label, ctx: LedgerCtx): GoalStatus {
  const goalClaims = claims.filter((c) => c.answersGoal && c.status === "active");
  if (!goalClaims.length) return { reached: false, why: ["No claim has been recorded as answering the goal."] };
  let best: { why: string[]; claimId: string } | undefined;
  for (const c of goalClaims) {
    const why: string[] = [];
    if (c.stale) why.push(`${c.id} is invalidated by a failed dependency.`);
    if (labelRank(c.label) < labelRank(standard)) {
      why.push(`${c.id} is "${LABEL_NAMES[c.label]}"; the required standard is "${LABEL_NAMES[standard]}".`);
    }
    const standing = blockingObjections(c, ctx.objectionsOf(c.id));
    if (standing.length) why.push(`${c.id} has standing objections: ${standing.map((o) => o.id).join(", ")}.`);
    if (ctx.mode !== "individual") {
      const req = requiredReviewers(c, ctx);
      const reviews = ctx.reviewsOf(c.id);
      if (!req.length) why.push("No other lead is active to confirm the answer.");
      const missing = req.filter((l) => !reviews.some((r) => r.byAgent === l.id && r.revision === c.revision && r.verdict === "accept" && r.satisfiesGoal));
      if (missing.length) why.push(`${c.id} still needs ${missing.map((l) => l.name).join(", ")} to accept it and confirm that it answers the goal.`);
    }
    if (!why.length) return { reached: true, claimId: c.id, why: [] };
    if (!best || why.length < best.why.length) best = { why, claimId: c.id };
  }
  return { reached: false, claimId: best?.claimId, why: best?.why ?? [] };
}
