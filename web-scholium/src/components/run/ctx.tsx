// What every part of the run screen shares: the live data, and how to look up and open one item of the ledger.
import { createContext, useContext } from "react";

import { modelColor } from "@/components/bits";
import { agentName, type Data } from "@/engine/report";
import { clip } from "@/engine/util";
import type { RunStore, RunView } from "@/lib/runStore";
import { LABEL_NAMES, type EntityKind, type EntityMap, type RunState } from "@/shared/types";

export interface RunCtx {
  id: string;
  view: RunView;
  store: RunStore;
  data: Data;
  run: RunState;
  /** Opens the detail panel for one item: a claim, an agent, an experiment, a source… */
  open: (ref: string) => void;
}

const Ctx = createContext<RunCtx | null>(null);
export const RunProvider = Ctx.Provider;
export function useRunCtx(): RunCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("This part of the screen only works inside a project.");
  return c;
}

const PREFIX: Record<string, EntityKind> = {
  A: "artifact",
  C: "claim",
  E: "experiment",
  I: "instruction",
  K: "checkpoint",
  L: "leancheck",
  M: "email",
  N: "note",
  O: "obligation",
  Q: "call",
  R: "review",
  S: "source",
  T: "task",
  U: "upload",
  V: "evidence",
  X: "objection",
};

export type Found = { [K in EntityKind]: { kind: K; item: EntityMap[K] } }[EntityKind];

/** The item an id points at, or nothing when this run has no such item. Ids are never guessed. */
export function find(d: Data, ref: string): Found | undefined {
  const kind: EntityKind | undefined = /^(lead|sub)-/.test(ref) ? "agent" : PREFIX[ref.charAt(0)];
  if (!kind) return undefined;
  const item = (d[kind] as { id: string }[]).find((x) => x.id === ref);
  return item ? ({ kind, item } as unknown as Found) : undefined;
}

export const brief = (text: string, n = 140): string => clip(text.replace(/\s+/g, " ").trim(), n);
export const words = (s: string): string => s.replace(/_/g, " ");

/** The opening of a long text, cut at a paragraph break so that formulas are not split in half. */
export function opening(text: string, n = 900): { text: string; cut: boolean } {
  if (text.length <= n) return { text, cut: false };
  const head = text.slice(0, n);
  const at = head.lastIndexOf("\n\n");
  return { text: at > n * 0.4 ? head.slice(0, at) : head.slice(0, Math.max(head.lastIndexOf(" "), 1)), cut: true };
}

export function describe(d: Data, ref: string): string | undefined {
  const f = find(d, ref);
  if (!f) return undefined;
  switch (f.kind) {
    case "claim":
      return `${LABEL_NAMES[f.item.label]} — ${brief(f.item.statement)}`;
    case "agent":
      return `${f.item.name} — ${brief(f.item.role)}`;
    case "experiment":
      return `Experiment (${words(f.item.status)}) — ${brief(f.item.purpose)}`;
    case "source":
      return `Source — ${brief(f.item.title)}`;
    case "objection":
      return `${f.item.severity} objection, ${f.item.status} — ${brief(f.item.text)}`;
    case "obligation":
      return `Obligation, ${f.item.status} — ${brief(f.item.text)}`;
    case "review":
      return `Review: ${words(f.item.verdict)} — ${brief(f.item.summary)}`;
    case "evidence":
      return `Evidence (${f.item.kind}, ${f.item.stance}) — ${brief(f.item.summary)}`;
    case "leancheck":
      return `Lean check ${f.item.ok ? "passed" : "failed"} — ${f.item.theoremName}`;
    case "artifact":
      return `${f.item.kind} — ${brief(f.item.title)}`;
    case "note":
      return `${words(f.item.kind)} note — ${brief(f.item.text)}`;
    case "upload":
      return `Your file — ${f.item.name}`;
    case "task":
      return `Task — ${brief(f.item.title)}`;
    case "instruction":
      return `Your message — ${brief(f.item.text)}`;
    case "checkpoint":
      return `Checkpoint — ${brief(f.item.reason)}`;
    case "email":
      return `Email — ${brief(f.item.subject)}`;
    default:
      return undefined;
  }
}

/** Who did something: the agent's name in its model's colour, opening the agent when pressed. */
export function Who({ id, className = "" }: { id: string; className?: string }) {
  const { data, open } = useRunCtx();
  const a = data.agent.find((x) => x.id === id);
  if (!a) return <span className={`text-muted-foreground ${className}`}>{agentName(data, id)}</span>;
  return (
    <button type="button" onClick={() => open(a.id)} title={a.role} className={`press inline-flex max-w-full items-center gap-1.5 align-baseline hover:underline ${className}`}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: modelColor(a.model) }} />
      <span className="truncate">{a.name}</span>
    </button>
  );
}
