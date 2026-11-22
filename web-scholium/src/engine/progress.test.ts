import { describe, expect, it } from "vitest";

import { defaultConfig, type Agent, type Claim, type Label, type Mode, type Objection, type Review } from "../shared/types";
import { goalProgress, type ProgressData } from "./progress";

const lead = (id: string, active = true): Agent => ({ id, kind: "lead", name: id, team: id, active }) as Agent;
const claim = (id: string, label: Label, more: Partial<Claim> = {}): Claim =>
  ({ id, label, proposedLabel: label, team: "lead-a", status: "active", stale: false, answersGoal: true, revision: 1, blockers: [], updatedAt: 1, ...more }) as Claim;
const accept = (claimId: string, byAgent: string): Review => ({ id: `R-${byAgent}`, claimId, revision: 1, byAgent, verdict: "accept", satisfiesGoal: true }) as Review;
const run = (standard: Label, mode: Mode, reached?: string) => ({ config: { ...defaultConfig(), standard, mode }, goalReached: !!reached, goalClaimId: reached });
const data = (d: Partial<ProgressData>): ProgressData => ({ agent: [lead("lead-a"), lead("lead-b")], claim: [], objection: [], review: [], ...d });

describe("goalProgress", () => {
  it("shows nothing done when no claim answers the goal", () => {
    const p = goalProgress(run("reviewed", "collaborative"), data({ claim: [claim("C1", "partial", { answersGoal: false })] }));
    expect(p.done).toBe(0);
    expect(p.steps).toEqual(["Conjecture", "Numerical evidence", "Partial result", "Candidate proof", "Model-reviewed argument", "Confirmed"]);
    expect(p.missing[0]).toMatch(/No claim/);
  });

  it("counts the rungs the strongest standing answer has climbed", () => {
    const p = goalProgress(run("reviewed", "collaborative"), data({ claim: [claim("C1", "conjecture"), claim("C2", "partial")] }));
    expect(p.claimId).toBe("C2");
    expect(p.done).toBe(3);
    expect(p.missing.join(" ")).toMatch(/required standard/);
    expect(p.missing.join(" ")).toMatch(/lead-b/);
  });

  it("stops one step short until the server records the goal as reached", () => {
    const d = data({ claim: [claim("C2", "reviewed")], review: [accept("C2", "lead-b")] });
    const waiting = goalProgress(run("reviewed", "collaborative"), d);
    expect(waiting.done).toBe(5);
    expect(waiting.reached).toBe(false);
    const reached = goalProgress(run("reviewed", "collaborative", "C2"), d);
    expect(reached.done).toBe(6);
    expect(reached.reached).toBe(true);
    expect(reached.missing).toEqual([]);
  });

  it("does not count a label above the required standard as extra progress", () => {
    const p = goalProgress(run("partial", "collaborative"), data({ claim: [claim("C1", "candidate")] }));
    expect(p.steps).toHaveLength(4);
    expect(p.done).toBe(3);
  });

  it("reports standing objections", () => {
    const o = { id: "O1", claimId: "C1", revision: 1, status: "open", severity: "major" } as Objection;
    const p = goalProgress(run("partial", "collaborative"), data({ claim: [claim("C1", "partial")], objection: [o], review: [accept("C1", "lead-b")] }));
    expect(p.missing.join(" ")).toMatch(/O1/);
  });

  it("gives an invalidated answer no credit and ignores refuted ones", () => {
    const p = goalProgress(run("reviewed", "collaborative"), data({ claim: [claim("C1", "candidate", { stale: true }), claim("C2", "reviewed", { status: "refuted" })] }));
    expect(p.claimId).toBe("C1");
    expect(p.done).toBe(0);
    expect(p.missing.join(" ")).toMatch(/invalidated/);
  });

  it("applies the single-lead rule to the standard", () => {
    const p = goalProgress(run("formal", "debate"), data({ agent: [lead("lead-a"), lead("lead-b", false)], claim: [claim("C1", "candidate")] }));
    expect(p.standard).toBe("candidate");
    expect(p.steps).toHaveLength(5);
    expect(p.done).toBe(4);
  });
});
