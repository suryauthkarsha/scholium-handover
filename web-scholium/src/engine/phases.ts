// The research workflow: which phase a run is in, which leads take part in it, and when it moves on.
// A phase holds at most one task per lead, cycle and round, so nothing here can loop without doing work.
import { LABEL_NAMES, PHASE_NAMES, type Agent, type Phase, type Task, type TaskType } from "../shared/types";
import { checkpoint, notify } from "./background";
import { LEAD_TASKS, TERMINAL, maxRounds } from "./consts";
import type { Engine } from "./engine";
import { oneLine } from "./util";

const ORDER: Phase[] = ["setup", "understand", "prior_work", "work", "cross_review", "revise", "confirm", "decide", "report", "done"];
const MAX_TURNS: Record<string, number> = { understand: 16, prior_work: 40, work: 120, cross_review: 80, revise: 80, confirm: 60, decide: 12, report: 24 };
const SKIPPED: Partial<Record<Phase, string>> = {
  cross_review: "no claim is waiting for another lead's review",
  revise: "no objection, rejected review or gap is waiting for an answer",
  confirm: "no response is waiting for a ruling",
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const roundOf = (t: Task): number => num(t.input.round);

export function newLeadTask(eng: Engine, type: TaskType, lead: Agent): Task {
  const reported = new Set<string>();
  for (const t of eng.m.task.values()) if (t.agentId === lead.id) for (const id of strs(t.input.reported)) reported.add(id);
  const name = (PHASE_NAMES as Record<string, string>)[type] ?? type;
  const task = eng.newTask(type, lead, {
    title: `${name} — ${lead.name}`,
    maxTurns: MAX_TURNS[type] ?? 40,
    maxOutput: 48000,
    input: { round: eng.run.reviseRound, reported: [...reported] },
  });
  eng.put("task", task);
  eng.refreshLead(lead.id);
  return task;
}

/** A lead has something to answer: an objection, a review that did not accept, or a gap another team found. */
function needsRevise(eng: Engine, lead: Agent): boolean {
  const mine = (claimId: string): boolean => {
    const c = eng.m.claim.get(claimId);
    return !!c && c.team === lead.team && c.status === "active";
  };
  for (const o of eng.m.objection.values()) if ((o.status === "open" || o.status === "unresolved") && mine(o.claimId)) return true;
  for (const r of eng.m.review.values()) {
    if (r.verdict === "accept" || r.byAgent === lead.id || !mine(r.claimId)) continue;
    if (eng.m.claim.get(r.claimId)?.revision === r.revision) return true;
  }
  for (const o of eng.m.obligation.values()) {
    if (o.status !== "open" || !mine(o.claimId)) continue;
    if (eng.m.agent.get(o.raisedBy)?.team !== lead.team) return true;
  }
  return false;
}

/** A lead has something to rule on: a revised claim, a response to its objection, or a verdict that events have overtaken. */
function needsConfirm(eng: Engine, lead: Agent): boolean {
  if (eng.reviewQueue(lead.id).length) return true;
  for (const o of eng.m.objection.values()) if (o.status === "answered" && o.team === lead.team) return true;
  for (const r of eng.m.review.values()) {
    if (r.byAgent !== lead.id || r.verdict === "accept") continue;
    const c = eng.m.claim.get(r.claimId);
    if (!c || c.status !== "active" || c.revision !== r.revision) continue;
    for (const o of eng.m.objection.values()) if (o.claimId === c.id && o.updatedAt > r.createdAt) return true;
    for (const o of eng.m.obligation.values()) if (o.claimId === c.id && o.status === "discharged" && o.updatedAt > r.createdAt) return true;
  }
  return false;
}

function participants(eng: Engine, phase: Phase): Agent[] {
  const leads = eng.activeLeads();
  switch (phase) {
    case "understand":
    case "prior_work":
    case "work":
    case "decide":
      return leads;
    case "cross_review":
      return leads.filter((l) => eng.reviewQueue(l.id).length > 0);
    case "revise":
      return eng.mode() === "individual" ? [] : leads.filter((l) => needsRevise(eng, l));
    case "confirm":
      return eng.mode() === "individual" ? [] : leads.filter((l) => needsConfirm(eng, l));
    case "report": {
      const goal = eng.run.goalClaimId ? eng.m.claim.get(eng.run.goalClaimId) : undefined;
      const author = goal ? leads.find((l) => l.id === goal.team) : undefined;
      const pick = author ?? leads[0];
      return pick ? [pick] : [];
    }
    default:
      return [];
  }
}

function setPhase(eng: Engine, phase: Phase): void {
  eng.run.phase = phase;
  eng.touch();
}

/** Asks the ledger whether the goal is met. The models' own opinion does not enter into it. */
function goalCheck(eng: Engine): void {
  const r = eng.run;
  eng.reassess();
  const g = eng.goalState();
  if (g.reached && g.claimId) {
    const first = !r.goalReached || r.goalClaimId !== g.claimId;
    r.goalReached = true;
    r.goalClaimId = g.claimId;
    setPhase(eng, "report");
    if (first) {
      const c = eng.m.claim.get(g.claimId);
      eng.event("success", "goal", `Goal reached: ${g.claimId} stands as "${c ? LABEL_NAMES[c.label] : "?"}" and meets the required standard. Writing the report.`, undefined, g.claimId);
      notify(eng, "goal");
    }
    return;
  }
  if (r.goalReached) {
    r.goalReached = false;
    r.goalClaimId = undefined;
  }
  setPhase(eng, "decide");
}

function complete(eng: Engine): void {
  const r = eng.run;
  eng.reassess();
  const g = eng.goalState();
  if (!g.reached || !g.claimId) {
    r.goalReached = false;
    r.goalClaimId = undefined;
    eng.event("warn", "goal", `The answer no longer meets the required standard${g.why.length ? `: ${oneLine(g.why.join(" "), 400)}` : "."} The investigation continues.`, undefined, g.claimId);
    setPhase(eng, "decide");
    return;
  }
  const c = eng.m.claim.get(g.claimId);
  const std = eng.effectiveStandard();
  r.goalReached = true;
  r.goalClaimId = g.claimId;
  r.status = "completed";
  r.phase = "done";
  r.endedAt = eng.now();
  r.outcome = `Goal reached: ${g.claimId} stands as "${c ? LABEL_NAMES[c.label] : LABEL_NAMES[std]}".${
    std !== r.config.standard ? ` With a single lead, or in individual mode, the highest label a claim can reach is "${LABEL_NAMES[std]}", so the run was held to that instead of "${LABEL_NAMES[r.config.standard]}".` : ""
  }`;
  eng.touch();
  for (const a of eng.activeLeads()) eng.refreshLead(a.id);
  eng.event("success", "run", `Run completed. ${r.outcome}`, undefined, g.claimId);
  checkpoint(eng, "completed");
}

function afterDecide(eng: Engine): void {
  const r = eng.run;
  if (r.counters.decidedCycle !== r.cycle) {
    r.counters.decidedCycle = r.cycle;
    const done = eng.all("task").filter((t) => t.type === "decide" && t.cycle === r.cycle && t.status === "done");
    const stalled = done.length > 0 && done.every((t) => t.result?.status === "stalled");
    r.stalledStreak = stalled ? r.stalledStreak + 1 : 0;
    const focus = done
      .map((t) => {
        const f = typeof t.result?.nextFocus === "string" ? t.result.nextFocus.trim() : "";
        return f ? `${eng.m.agent.get(t.agentId)?.name ?? t.agentId}: ${f}` : "";
      })
      .filter(Boolean)
      .join("\n");
    r.focus = focus || undefined;
    eng.touch();
    if (r.stalledStreak >= 2) {
      eng.attention(`Every lead reported no progress for ${r.stalledStreak} cycles in a row. Give the leads a new direction with an instruction, change the models or the tools, and resume; or stop the run.`);
      return;
    }
  }
  const max = r.config.limits.maxCycles;
  if (!r.config.limits.untilSpend && r.cycle >= max) {
    eng.pauseRun(`The limit of ${max} cycle${max === 1 ? "" : "s"} is reached and the goal is not met. Raise the limit and resume to continue.`, true);
    return;
  }
  checkpoint(eng, `end of cycle ${r.cycle}`);
  r.cycle += 1;
  r.reviseRound = 0;
  setPhase(eng, "work");
}

function transition(eng: Engine, phase: Phase): void {
  const r = eng.run;
  const mode = eng.mode();
  const anyRevise = (): boolean => mode !== "individual" && eng.activeLeads().some((l) => needsRevise(eng, l));
  switch (phase) {
    case "understand": {
      const canLook = eng.toolOk("web") || eng.toolOk("literature") || eng.toolOk("oeis") || eng.m.upload.size > 0;
      if (!canLook) eng.event("warn", "phase", "Prior work is skipped: no retrieval tool is available and nothing was uploaded. Nothing in this run can be attributed to the literature.");
      setPhase(eng, canLook ? "prior_work" : "work");
      return;
    }
    case "prior_work":
      setPhase(eng, "work");
      return;
    case "work":
      if (mode === "individual") goalCheck(eng);
      else setPhase(eng, "cross_review");
      return;
    case "cross_review":
      if (anyRevise()) setPhase(eng, "revise");
      else goalCheck(eng);
      return;
    case "revise":
      setPhase(eng, "confirm");
      return;
    case "confirm":
      r.reviseRound += 1;
      eng.touch();
      if (r.reviseRound < maxRounds(mode) && anyRevise()) setPhase(eng, "revise");
      else goalCheck(eng);
      return;
    case "decide":
      afterDecide(eng);
      return;
    case "report":
      complete(eng);
      return;
    default:
      return;
  }
}

/** Moves the run through its phases: creates the tasks of the current phase and, once they are over, picks the next one. */
export function advance(eng: Engine): void {
  for (let guard = 0; guard < 12; guard++) {
    const r = eng.run;
    if (r.status !== "running") return;
    const phase = r.phase;
    if (phase === "setup" || phase === "done") return;
    const type = phase as TaskType;
    const key = r.cycle * 1000 + ORDER.indexOf(phase) * 10 + Math.min(r.reviseRound, 9);
    const entering = r.counters.entered !== key;
    const taking = participants(eng, phase);
    if (entering) {
      r.counters.entered = key;
      eng.touch();
      const round = (phase === "revise" || phase === "confirm") && maxRounds(eng.mode()) > 1 ? `, round ${r.reviseRound + 1}` : "";
      if (taking.length) eng.event("info", "phase", `Cycle ${r.cycle} · ${PHASE_NAMES[phase]}${round}: ${taking.map((l) => l.name).join(", ")}.`);
      else if (SKIPPED[phase]) eng.event("info", "phase", `Cycle ${r.cycle} · ${PHASE_NAMES[phase]}${round} skipped: ${SKIPPED[phase]}.`);
    }
    const existing = eng.all("task").filter((t) => t.type === type && t.cycle === r.cycle && roundOf(t) === r.reviseRound);
    for (const lead of taking) {
      if (existing.some((t) => t.agentId === lead.id)) continue;
      existing.push(newLeadTask(eng, type, lead));
    }
    if (existing.some((t) => !TERMINAL.has(t.status))) return;
    transition(eng, phase);
  }
}

/** Gets a paused, stopped or completed run ready to run again. */
export function prepareResume(eng: Engine): void {
  const r = eng.run;
  for (const k of Object.keys(r.counters)) if (k.startsWith("fail_")) r.counters[k] = 0;
  r.stalledStreak = 0;
  if (r.status === "stopped" || r.status === "completed") {
    r.cycle += 1;
    r.phase = "work";
    r.goalReached = false;
    r.goalClaimId = undefined;
    r.reviseRound = 0;
    eng.touch();
    return;
  }
  for (const t of eng.all("task")) {
    if (!LEAD_TASKS.has(t.type) || t.status !== "failed") continue;
    if (t.cycle !== r.cycle || t.type !== r.phase || roundOf(t) !== r.reviseRound) continue;
    const a = eng.m.agent.get(t.agentId);
    if (!a || !a.active) continue;
    t.status = "queued";
    t.attempts = 0;
    t.error = undefined;
    t.endedAt = undefined;
    t.notBefore = undefined;
    eng.put("task", t);
    eng.refreshLead(a.id);
  }
  eng.touch();
}
