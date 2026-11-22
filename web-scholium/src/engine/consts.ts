// Small shared constants, kept apart so the engine's modules can use them without importing each other's code.
import type { Mode, TaskType } from "../shared/types";

export const TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);
export const AGENT_TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
export const LEAD_TASKS: ReadonlySet<TaskType> = new Set<TaskType>(["understand", "prior_work", "work", "cross_review", "revise", "confirm", "decide", "report"]);

/** Respond/confirm rounds per cycle: a debate gets a second exchange. */
export const maxRounds = (mode: Mode): number => (mode === "debate" ? 2 : 1);
