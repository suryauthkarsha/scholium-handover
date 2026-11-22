import { describe, expect, it } from "vitest";

import { addUsage, allowanceBlocked, canSpend, chargeDiag, committed, grant, newBudget, newUsage, remove, report, setCap, take, view } from "./budget";

const T0 = Date.UTC(2026, 10, 21, 12);
const NEXT_MONTH = Date.UTC(2026, 11, 2, 12);

describe("monthly ceiling", () => {
  it("never commits more than the ceiling across concurrent runs", () => {
    const b = newBudget(T0, 25);
    const a = grant(b, "a", { limitUsd: 15, spentUsd: 0, reservedUsd: 0 }, T0);
    expect(a).toEqual({ ok: true, limitUsd: 15, clamped: false });
    const c = grant(b, "b", { limitUsd: 40, spentUsd: 0, reservedUsd: 0 }, T0);
    expect(c).toEqual({ ok: true, limitUsd: 10, clamped: true });
    const d = grant(b, "c", { limitUsd: 5, spentUsd: 0, reservedUsd: 0 }, T0);
    expect(d.ok).toBe(false);
    expect(committed(b)).toBeLessThanOrEqual(25);
  });

  it("frees headroom when a run stops and keeps what it spent", () => {
    const b = newBudget(T0, 25);
    grant(b, "a", { limitUsd: 20, spentUsd: 0, reservedUsd: 0 }, T0);
    expect(report(b, "a", { limitUsd: 20, spentUsd: 6, reservedUsd: 0, active: false }, T0)).toEqual({});
    expect(committed(b)).toBeCloseTo(6);
    const again = grant(b, "b", { limitUsd: 30, spentUsd: 0, reservedUsd: 0 }, T0);
    expect(again).toEqual({ ok: true, limitUsd: 19, clamped: true });
    remove(b, "a");
    expect(committed(b)).toBeCloseTo(25);
    expect(view(b, T0).spentUsd).toBeCloseTo(6);
  });

  it("tells a run to lower a limit it raised by itself, and flags a run working without a grant", () => {
    const b = newBudget(T0, 25);
    grant(b, "a", { limitUsd: 10, spentUsd: 0, reservedUsd: 0 }, T0);
    expect(report(b, "a", { limitUsd: 500, spentUsd: 1, reservedUsd: 2, active: true }, T0)).toEqual({ clampTo: 10 });
    expect(committed(b)).toBeCloseTo(10);
    expect(report(b, "ghost", { limitUsd: 40, spentUsd: 0, reservedUsd: 0, active: true }, T0)).toEqual({ ungranted: true });
    report(b, "a", { limitUsd: 10, spentUsd: 2, reservedUsd: 0, active: false }, T0);
    expect(report(b, "a", { limitUsd: 10, spentUsd: 2, reservedUsd: 0, active: true }, T0)).toEqual({ ungranted: true });
  });

  it("refuses to resume a run that has no room left", () => {
    const b = newBudget(T0, 25);
    grant(b, "a", { limitUsd: 25, spentUsd: 0, reservedUsd: 0 }, T0);
    report(b, "a", { limitUsd: 25, spentUsd: 24.99, reservedUsd: 0, active: false }, T0);
    const g = grant(b, "a", { limitUsd: 25, spentUsd: 24.99, reservedUsd: 0 }, T0);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain("$25.00");
  });

  it("starts each month fresh but still counts a continuing run's remaining limit", () => {
    const b = newBudget(T0, 25);
    grant(b, "a", { limitUsd: 20, spentUsd: 0, reservedUsd: 0 }, T0);
    report(b, "a", { limitUsd: 20, spentUsd: 12, reservedUsd: 0, active: true }, T0);
    const v = view(b, NEXT_MONTH);
    expect(v.spentUsd).toBe(0);
    expect(v.committedUsd).toBeCloseTo(8);
    const g = grant(b, "b", { limitUsd: 40, spentUsd: 0, reservedUsd: 0 }, NEXT_MONTH);
    expect(g).toEqual({ ok: true, limitUsd: 17, clamped: true });
  });

  it("takes back unused headroom when the ceiling is lowered", () => {
    const b = newBudget(T0, 50);
    grant(b, "a", { limitUsd: 30, spentUsd: 0, reservedUsd: 0 }, T0);
    grant(b, "b", { limitUsd: 20, spentUsd: 0, reservedUsd: 0 }, T0);
    report(b, "a", { limitUsd: 30, spentUsd: 5, reservedUsd: 1, active: true }, T0);
    const { clamps } = setCap(b, 20, T0);
    expect(Object.keys(clamps).length).toBeGreaterThan(0);
    expect(committed(b)).toBeLessThanOrEqual(20.001);
    expect(b.runs.a.limitUsd).toBeGreaterThanOrEqual(6);
  });

  it("charges diagnostics to the month and refuses them when the month is spent", () => {
    const b = newBudget(T0, 5);
    expect(canSpend(b, 4.2, T0)).toBe(true);
    chargeDiag(b, 1.5, T0);
    expect(canSpend(b, 4.2, T0)).toBe(false);
    expect(view(b, T0).diagUsd).toBeCloseTo(1.5);
  });
});

describe("free allowances", () => {
  it("pauses at 80% of the daily backend allowance and clears at the next UTC day", () => {
    const u = newUsage(T0);
    addUsage(u, { written: 79_999 }, T0);
    expect(allowanceBlocked(u, T0)).toBeNull();
    addUsage(u, { written: 1 }, T0);
    expect(allowanceBlocked(u, T0)).toContain("rows written");
    expect(allowanceBlocked(u, T0 + 24 * 3600_000)).toBeNull();
    addUsage(u, { calls: 5 }, T0 + 24 * 3600_000);
    expect(u.written).toBe(0);
    expect(u.calls).toBe(5);
  });

  it("caps emails and Drive uploads per day", () => {
    const t = { day: "", email: 0, drive: 0 };
    let sent = 0;
    for (let i = 0; i < 50; i++) if (take(t, "email", T0)) sent++;
    expect(sent).toBe(30);
    expect(take(t, "email", T0)).toBe(false);
    expect(take(t, "drive", T0)).toBe(true);
    expect(take(t, "email", T0 + 24 * 3600_000)).toBe(true);
  });
});
