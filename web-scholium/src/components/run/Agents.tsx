// Every agent of the project: a graph of who delegated to whom that can be zoomed and moved, and a searchable list.
import { Maximize2, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Chip, Empty, Meter, ModelTag, Section, modelColor, usd } from "@/components/bits";
import { Input } from "@/components/ui/input";
import { MODELS } from "@/shared/models";
import { SUBAGENT_HARD_CAP, type Agent, type AgentStatus } from "@/shared/types";

import { MathText } from "@/components/Markdown";

import { brief, useRunCtx } from "./ctx";

const DX = 34;
const DY = 92;
const TONE: Record<AgentStatus, "muted" | "live" | "ok" | "warn" | "bad"> = { idle: "muted", queued: "muted", running: "live", waiting: "warn", completed: "ok", failed: "bad", cancelled: "muted" };

interface Node {
  a: Agent;
  x: number;
  y: number;
  parent?: Node;
}

/** Leaves take consecutive columns; a parent sits above the middle of its children. Order is the order of creation. */
function layout(agents: Agent[]): { nodes: Node[]; w: number; h: number } {
  const ids = new Set(agents.map((a) => a.id));
  const kids = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const a of agents) {
    if (a.parentId && ids.has(a.parentId)) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a]);
    else roots.push(a);
  }
  const nodes: Node[] = [];
  let column = 0;
  let deepest = 0;
  const place = (a: Agent, depth: number, parent?: Node): Node => {
    const n: Node = { a, x: 0, y: depth * DY, parent };
    nodes.push(n);
    deepest = Math.max(deepest, depth);
    const below = depth < 8 ? (kids.get(a.id) ?? []).map((c) => place(c, depth + 1, n)) : [];
    const first = below[0];
    const last = below[below.length - 1];
    n.x = first && last ? (first.x + last.x) / 2 : column++ * DX;
    return n;
  };
  roots.forEach((r, i) => {
    if (i) column += 1;
    place(r, 0);
  });
  return { nodes, w: Math.max(column - 1, 0) * DX, h: deepest * DY };
}

function Graph({ nodes, w, h, match }: { nodes: Node[]; w: number; h: number; match: Set<string> | null }) {
  const { open } = useRunCtx();
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const touched = useRef(false);
  const [size, setSize] = useState({ w: 640, h: 320 });
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });

  const fit = useCallback(() => {
    const pad = 44;
    const k = Math.max(0.12, Math.min((size.w - pad * 2) / Math.max(w, 1), (size.h - pad * 2) / Math.max(h, 1), 1.4));
    setT({ k, x: (size.w - w * k) / 2, y: (size.h - h * k) / 2 });
  }, [size.w, size.h, w, h]);

  // Until the reader moves the graph, it keeps fitting itself as agents are added.
  useEffect(() => {
    if (!touched.current) fit();
  }, [fit]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain scrolling still scrolls the page
      e.preventDefault();
      touched.current = true;
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setT((p) => {
        const k = Math.min(4, Math.max(0.12, p.k * Math.exp(-e.deltaY * 0.01)));
        const f = k / p.k;
        return { k, x: mx - (mx - p.x) * f, y: my - (my - p.y) * f };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", wheel);
    };
  }, []);

  const zoom = (f: number) => {
    touched.current = true;
    setT((p) => {
      const k = Math.min(4, Math.max(0.12, p.k * f));
      const g = k / p.k;
      return { k, x: size.w / 2 - (size.w / 2 - p.x) * g, y: size.h / 2 - (size.h / 2 - p.y) * g };
    });
  };
  const release = () => window.setTimeout(() => (drag.current = null), 0);

  return (
    <div
      ref={box}
      className="relative h-[44vh] min-h-[260px] cursor-grab touch-none select-none overflow-hidden rounded-md border bg-card/40 active:cursor-grabbing"
      onPointerDown={(e) => (drag.current = { px: e.clientX, py: e.clientY, x: t.x, y: t.y, moved: false })}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.px;
        const dy = e.clientY - d.py;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        touched.current = true;
        setT((p) => ({ ...p, x: d.x + dx, y: d.y + dy }));
      }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
    >
      <svg width={size.w} height={size.h} role="img" aria-label="Graph of the agents and who delegated to whom">
        <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
          {nodes.map((n) =>
            n.parent ? (
              <path
                key={`e-${n.a.id}`}
                d={`M${n.parent.x},${n.parent.y} C${n.parent.x},${(n.parent.y + n.y) / 2} ${n.x},${(n.parent.y + n.y) / 2} ${n.x},${n.y}`}
                fill="none"
                stroke="hsl(var(--rule))"
                strokeWidth={1.2 / Math.max(t.k, 0.5)}
                opacity={match && !match.has(n.a.id) ? 0.25 : 1}
              />
            ) : null,
          )}
          {nodes.map((n) => {
            const lead = n.a.kind === "lead";
            const r = lead ? 13 : 8;
            const c = modelColor(n.a.model);
            const s = n.a.status;
            const hollow = s === "queued" || s === "idle" || s === "cancelled";
            const dim = (match && !match.has(n.a.id)) || (lead && !n.a.active);
            return (
              <g
                key={n.a.id}
                transform={`translate(${n.x},${n.y})`}
                opacity={dim ? 0.22 : s === "cancelled" ? 0.55 : 1}
                className="cursor-pointer outline-none"
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (!drag.current?.moved) open(n.a.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") open(n.a.id);
                }}
              >
                <title>{`${n.a.name} — ${s}\n${n.a.role}`}</title>
                {s === "running" ? <circle r={r + 5} fill={c} opacity={0.28} className="animate-pulse" /> : null}
                <circle r={r} fill={hollow ? "hsl(var(--background))" : c} stroke={s === "failed" ? "hsl(var(--destructive))" : c} strokeWidth={s === "failed" ? 3 : lead ? 2.5 : 1.6} strokeDasharray={s === "cancelled" ? "3 2.5" : undefined} />
                {s === "waiting" ? <circle r={r / 2.6} fill="hsl(var(--background))" /> : null}
                {lead || t.k >= 0.85 ? (
                  <text y={r + (lead ? 15 : 12)} textAnchor="middle" fontSize={lead ? 12 : 9} className="fill-foreground font-sans" style={{ paintOrder: "stroke", stroke: "hsl(var(--background))", strokeWidth: 3 }}>
                    {brief(n.a.name, lead ? 26 : 16)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="absolute right-2 top-2 flex overflow-hidden rounded-sm border bg-background" onPointerDown={(e) => e.stopPropagation()}>
        {(
          [
            ["Zoom out", () => zoom(1 / 1.3), Minus],
            ["Zoom in", () => zoom(1.3), Plus],
            [
              "Fit everything",
              () => {
                touched.current = false;
                fit();
              },
              Maximize2,
            ],
          ] as const
        ).map(([label, run, Icon]) => (
          <button key={label} type="button" aria-label={label} title={label} onClick={run} className="flex h-8 w-8 items-center justify-center border-l first:border-l-0 hover:bg-secondary">
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
      </div>
      <p className="pointer-events-none absolute bottom-2 left-3 right-3 flex flex-wrap gap-x-3 text-[0.7rem] text-muted-foreground">
        <span>filled = finished or working</span>
        <span>hollow = waiting to start</span>
        <span>red ring = failed</span>
        <span>dashed = cancelled</span>
        <span className="ml-auto hidden sm:inline">drag to move · Ctrl + scroll or pinch to zoom</span>
      </p>
    </div>
  );
}

export default function Agents() {
  const { data, run, open } = useRunCtx();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<AgentStatus | "all">("all");
  const g = useMemo(() => layout(data.agent), [data.agent]);
  const depth = useMemo(() => new Map(g.nodes.map((n) => [n.a.id, n.y / DY])), [g]);
  const needle = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      g.nodes
        .map((n) => n.a)
        .filter((a) => (status === "all" || a.status === status) && (!needle || [a.id, a.name, a.role, a.status, MODELS[a.model].short, a.assignment?.question ?? ""].some((s) => s.toLowerCase().includes(needle)))),
    [g, status, needle],
  );
  const match = needle || status !== "all" ? new Set(rows.map((a) => a.id)) : null;
  const s = run.subagents;
  const cap = Math.min(run.config.limits.subagentCap, SUBAGENT_HARD_CAP);
  const present = (["running", "waiting", "queued", "completed", "failed", "cancelled"] as AgentStatus[]).filter((k) => data.agent.some((a) => a.status === k));

  if (!data.agent.length) return <Empty title="No agents yet">The lead models and every subagent they create appear here once the project has been started.</Empty>;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-5 py-6">
      <div className="grid gap-x-8 gap-y-3 sm:grid-cols-[minmax(0,18rem)_1fr] sm:items-end">
        <div>
          <p className="eyebrow mb-1">Subagents created</p>
          <p className="tabular font-serif text-3xl leading-none">
            {s.created} <span className="text-lg text-muted-foreground">/ {cap}</span>
          </p>
          <div className="mt-2">
            <Meter value={s.created} max={Math.max(cap, 1)} tone={s.created >= cap ? "rubric" : "ink"} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{cap < SUBAGENT_HARD_CAP ? `This project's limit is ${cap}; no project may create more than ${SUBAGENT_HARD_CAP}.` : `No project may create more than ${SUBAGENT_HARD_CAP}.`}</p>
        </div>
        <p className="tabular flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{s.running} running</span>
          <span>{s.queued} queued</span>
          <span>{s.completed} finished</span>
          <span>{s.failed} failed</span>
          <span>{s.cancelled} cancelled</span>
          <span>up to {run.config.limits.concurrency} at once</span>
        </p>
      </div>

      <Graph nodes={g.nodes} w={g.w} h={g.h} match={match} />

      <Section title="All agents" aside={<span className="tabular text-xs text-muted-foreground">{rows.length === data.agent.length ? data.agent.length : `${rows.length} of ${data.agent.length}`}</span>}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, role, question or model" className="h-8 max-w-xs text-sm" />
          {(["all", ...present] as const).map((k) => (
            <button key={k} type="button" onClick={() => setStatus(k)} aria-pressed={status === k} className={`press rounded-sm border px-2 py-0.5 text-xs ${status === k ? "border-foreground bg-foreground text-background" : "bg-background hover:border-foreground/50"}`}>
              {k}
            </button>
          ))}
        </div>
        {rows.length ? (
          <ul>
            {rows.map((a) => (
              <li key={a.id} className="border-b last:border-b-0">
                <button type="button" onClick={() => open(a.id)} className="block w-full py-2 pr-1 text-left hover:bg-secondary/50" style={{ paddingLeft: 4 + (depth.get(a.id) ?? 0) * 16 }}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: modelColor(a.model) }} />
                    <span className={a.kind === "lead" ? "font-serif text-base" : "text-sm font-medium"}>{a.name}</span>
                    <ModelTag model={a.model} />
                    <Chip tone={TONE[a.status]}>{a.kind === "lead" && !a.active ? "removed" : a.status}</Chip>
                    {a.review ? <Chip tone={a.review.verdict === "reject" ? "bad" : a.review.verdict === "accept" ? "ok" : "warn"}>review: {a.review.verdict.replace(/_/g, " ")}</Chip> : null}
                    <span className="tabular ml-auto text-xs text-muted-foreground">
                      {usd(a.costUsd)} · {a.turns} {a.turns === 1 ? "turn" : "turns"}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground"><MathText text={brief(a.assignment?.question ?? a.role, 220)} /></span>
                  {a.error ? <span className="mt-0.5 block text-xs text-destructive">{brief(a.error, 220)}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-3 text-sm text-muted-foreground">No agent matches that search.</p>
        )}
      </Section>
    </div>
  );
}
