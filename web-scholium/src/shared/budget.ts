// Hard cost guardrails. Pure bookkeeping, shared by the workspace object and its tests.
// No model can reach or change any of this: the ceiling is set by the signed-in user in Settings only.

export const DEFAULT_MONTHLY_CAP_USD = 5000;
export const MAX_MONTHLY_CAP_USD = 5000;
export const MIN_GRANT_USD = 1;
/** The backend's free daily allowance (per project, reset at 00:00 UTC). Past it the backend pauses; it never bills. */
export const DO_DAILY_ALLOWANCE = { written: 100_000, read: 5_000_000, calls: 100_000 } as const;
/**
 * Runs are paused when any counter reaches this share of the allowance. It was 0.8; the owner asked for that stop to go.
 * What is left is only the room work already in flight needs to save its results before the platform's own wall at 100%,
 * past which every call to this site fails until 00:00 UTC.
 */
export const ALLOWANCE_PAUSE_AT = 0.95;
/** Daily caps on free-tier side effects. Resend's free plan allows 100 emails a day; Drive's free API quota is far higher. */
export const DAILY_TAKE_CAPS = { email: 30, drive: 600 } as const;
export type TakeKind = keyof typeof DAILY_TAKE_CAPS;

export interface RunLedger {
  /** The most this run may ever have spent, as granted. */
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  /** What the run had already spent when this month began (or when it was first seen this month). */
  monthBaseUsd: number;
  /** True while the run may start new model calls. */
  active: boolean;
  at: number;
}

export interface BudgetState {
  month: string;
  capUsd: number;
  /** This month's spend of runs that were deleted. */
  closedUsd: number;
  /** This month's spend on diagnostics and prompt evaluations. */
  diagUsd: number;
  runs: Record<string, RunLedger>;
}

export interface BudgetView {
  month: string;
  capUsd: number;
  spentUsd: number;
  /** Spent plus everything running runs are still allowed to spend. */
  committedUsd: number;
  availableUsd: number;
  diagUsd: number;
  runs: Record<string, { spentUsd: number; exposureUsd: number; active: boolean }>;
}

export interface DailyUsage {
  day: string;
  written: number;
  read: number;
  calls: number;
}

export interface UsageView extends DailyUsage {
  allowance: { written: number; read: number; calls: number };
  pauseAt: number;
  blocked: string | null;
  takes: { email: number; drive: number; caps: { email: number; drive: number } };
}

export interface TakeCounters {
  day: string;
  email: number;
  drive: number;
}

export type Grant = { ok: true; limitUsd: number; clamped: boolean } | { ok: false; reason: string };

export const monthOf = (now: number): string => new Date(now).toISOString().slice(0, 7);
export const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);
const cents = (n: number): number => Math.floor(n * 100 + 1e-6) / 100;
const usd = (n: number): string => `$${n.toFixed(2)}`;

export function newBudget(now: number, capUsd: number = DEFAULT_MONTHLY_CAP_USD): BudgetState {
  return { month: monthOf(now), capUsd, closedUsd: 0, diagUsd: 0, runs: {} };
}

/** Starts a new month: only what each run may still spend counts against the new ceiling. */
export function rollover(b: BudgetState, now: number): boolean {
  const m = monthOf(now);
  if (b.month === m) return false;
  b.month = m;
  b.closedUsd = 0;
  b.diagUsd = 0;
  for (const r of Object.values(b.runs)) r.monthBaseUsd = r.spentUsd;
  return true;
}

/** The most this run can still cost this month: its whole limit while it runs, otherwise what it spent and holds. */
export const exposure = (r: RunLedger): number => {
  const held = r.spentUsd + r.reservedUsd;
  return Math.max(0, (r.active ? Math.max(r.limitUsd, held) : held) - r.monthBaseUsd);
};

export function committed(b: BudgetState, exceptRunId?: string): number {
  let total = b.closedUsd + b.diagUsd;
  for (const [id, r] of Object.entries(b.runs)) if (id !== exceptRunId) total += exposure(r);
  return total;
}

export const available = (b: BudgetState, exceptRunId?: string): number => b.capUsd - committed(b, exceptRunId);

/** Asked before a run starts, resumes, or has its limit raised. Grants at most what the month still has. */
export function grant(b: BudgetState, id: string, ask: { limitUsd: number; spentUsd: number; reservedUsd: number }, now: number): Grant {
  rollover(b, now);
  const prev = b.runs[id];
  const base = prev ? Math.min(prev.monthBaseUsd, ask.spentUsd) : ask.spentUsd;
  const used = ask.spentUsd + ask.reservedUsd;
  const room = available(b, id);
  const limit = cents(Math.min(ask.limitUsd, base + room));
  if (limit < MIN_GRANT_USD || limit < used + 0.05) {
    const left = Math.max(0, room - (used - base));
    return { ok: false, reason: `The monthly ceiling of ${usd(b.capUsd)} leaves ${usd(left)} for this run, which is not enough to continue. Raise the ceiling in Settings, or wait for next month.` };
  }
  b.runs[id] = { limitUsd: limit, spentUsd: ask.spentUsd, reservedUsd: ask.reservedUsd, monthBaseUsd: base, active: true, at: now };
  return { ok: true, limitUsd: limit, clamped: limit < ask.limitUsd - 0.004 };
}

/** A run's own account of itself. The answer tells it to lower its limit, or that it is running without a grant. */
export function report(b: BudgetState, id: string, r: { limitUsd: number; spentUsd: number; reservedUsd: number; active: boolean }, now: number): { clampTo?: number; ungranted?: boolean } {
  rollover(b, now);
  const prev = b.runs[id];
  if (!prev) {
    b.runs[id] = { limitUsd: r.limitUsd, spentUsd: r.spentUsd, reservedUsd: r.reservedUsd, monthBaseUsd: r.spentUsd, active: false, at: now };
    return r.active ? { ungranted: true } : {};
  }
  prev.spentUsd = Math.max(prev.spentUsd, r.spentUsd);
  prev.reservedUsd = Math.max(0, r.reservedUsd);
  prev.at = now;
  if (!r.active) {
    prev.active = false;
    prev.limitUsd = r.limitUsd;
    return {};
  }
  if (!prev.active) return { ungranted: true };
  if (r.limitUsd > prev.limitUsd + 0.005) return { clampTo: prev.limitUsd };
  prev.limitUsd = r.limitUsd;
  return {};
}

/** A deleted run keeps counting for the rest of the month with what it actually spent. */
export function remove(b: BudgetState, id: string): void {
  const r = b.runs[id];
  if (!r) return;
  b.closedUsd += Math.max(0, r.spentUsd - r.monthBaseUsd);
  delete b.runs[id];
}

/** Changes the ceiling. If it now sits below what is committed, unused headroom is taken back from running runs. */
export function setCap(b: BudgetState, capUsd: number, now: number): { clamps: Record<string, number> } {
  rollover(b, now);
  b.capUsd = Math.min(MAX_MONTHLY_CAP_USD, Math.max(MIN_GRANT_USD, cents(capUsd)));
  const clamps: Record<string, number> = {};
  let over = committed(b) - b.capUsd;
  if (over <= 0) return { clamps };
  const running = Object.entries(b.runs)
    .filter(([, r]) => r.active)
    .sort((x, y) => y[1].limitUsd - y[1].spentUsd - (x[1].limitUsd - x[1].spentUsd));
  for (const [id, r] of running) {
    if (over <= 0) break;
    const headroom = Math.max(0, r.limitUsd - (r.spentUsd + r.reservedUsd));
    const cut = Math.min(headroom, over);
    if (cut <= 0) continue;
    r.limitUsd = cents(r.limitUsd - cut);
    over -= cut;
    clamps[id] = r.limitUsd;
  }
  return { clamps };
}

/** Charges work that belongs to no run. Returns false, charging nothing, when the month cannot afford `worstUsd`. */
export function canSpend(b: BudgetState, worstUsd: number, now: number): boolean {
  rollover(b, now);
  return available(b) >= worstUsd;
}

export function chargeDiag(b: BudgetState, costUsd: number, now: number): void {
  rollover(b, now);
  b.diagUsd += Math.max(0, costUsd);
}

export function view(b: BudgetState, now: number): BudgetView {
  rollover(b, now);
  const runs: BudgetView["runs"] = {};
  let spent = b.closedUsd + b.diagUsd;
  for (const [id, r] of Object.entries(b.runs)) {
    const s = Math.max(0, r.spentUsd - r.monthBaseUsd);
    spent += s;
    runs[id] = { spentUsd: s, exposureUsd: exposure(r), active: r.active };
  }
  const c = committed(b);
  return { month: b.month, capUsd: b.capUsd, spentUsd: spent, committedUsd: c, availableUsd: Math.max(0, b.capUsd - c), diagUsd: b.diagUsd, runs };
}

const COUNTER_NAMES = { written: "rows written", read: "rows read", calls: "backend calls" } as const;

export function newUsage(now: number): DailyUsage {
  return { day: dayOf(now), written: 0, read: 0, calls: 0 };
}

export function addUsage(u: DailyUsage, d: { written?: number; read?: number; calls?: number }, now: number): void {
  if (u.day !== dayOf(now)) Object.assign(u, newUsage(now));
  u.written += Math.max(0, d.written ?? 0);
  u.read += Math.max(0, d.read ?? 0);
  u.calls += Math.max(0, d.calls ?? 0);
}

/** The reason work must pause, or null while the free daily allowance still has room. */
export function allowanceBlocked(u: DailyUsage, now: number): string | null {
  if (u.day !== dayOf(now)) return null;
  for (const k of ["written", "read", "calls"] as const) {
    const cap = DO_DAILY_ALLOWANCE[k];
    if (u[k] >= cap * ALLOWANCE_PAUSE_AT) {
      return `Today's free backend allowance is ${Math.round((u[k] / cap) * 100)}% used (${u[k].toLocaleString("en-US")} of ${cap.toLocaleString("en-US")} ${COUNTER_NAMES[k]}). Research is paused so nothing can be billed; the allowance resets at 00:00 UTC.`;
    }
  }
  return null;
}

/** Takes one unit of a capped free-tier side effect. Returns false when today's cap is used up. */
export function take(t: TakeCounters, kind: TakeKind, now: number): boolean {
  if (t.day !== dayOf(now)) Object.assign(t, { day: dayOf(now), email: 0, drive: 0 });
  if (t[kind] >= DAILY_TAKE_CAPS[kind]) return false;
  t[kind] += 1;
  return true;
}

export function usageView(u: DailyUsage, t: TakeCounters, now: number): UsageView {
  const today = dayOf(now);
  const cur = u.day === today ? u : newUsage(now);
  const tk = t.day === today ? t : { day: today, email: 0, drive: 0 };
  return { ...cur, allowance: { ...DO_DAILY_ALLOWANCE }, pauseAt: ALLOWANCE_PAUSE_AT, blocked: allowanceBlocked(cur, now), takes: { email: tk.email, drive: tk.drive, caps: { ...DAILY_TAKE_CAPS } } };
}
