// The research view: the goal, what each lead is doing right now, the research map, and the ledger of claims.
import { useMemo, useState } from "react";

import { Chip, Empty, LabelChip, ModelTag, Section, modelColor, timeAgo } from "@/components/bits";
import { Markdown, MathText, Ref } from "@/components/Markdown";
import { tailText } from "@/shared/math";
import { Input } from "@/components/ui/input";
import { goalSummary, labelCounts, standingObjections } from "@/engine/report";
import { LABELS, LABEL_NAMES, PHASE_NAMES, labelRank, type Agent, type Claim, type Note } from "@/shared/types";

import { opening, useRunCtx, Who, words } from "./ctx";

const BUSY = new Set(["running", "queued", "waiting"]);

function LeadCard({ a }: { a: Agent }) {
  const { data, view, open } = useRunCtx();
  const task = useMemo(() => [...data.task].reverse().find((t) => t.agentId === a.id && (t.status === "running" || t.status === "waiting")), [data.task, a.id]);
  const stream = task ? view.streams.find((s) => s.taskId === task.id) : undefined;
  const team = data.agent.filter((x) => x.kind === "subagent" && x.team === a.id);
  const busy = team.filter((x) => BUSY.has(x.status)).length;
  const writing = stream?.text ?? "";
  const live = writing || stream?.thinking || "";
  return (
    <article className="rise rounded-md border border-l-2 bg-card/60 p-4" style={{ borderLeftColor: modelColor(a.model) }}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button type="button" onClick={() => open(a.id)} className="press font-serif text-lg leading-tight hover:underline">
          {a.name}
        </button>
        <ModelTag model={a.model} />
        <Chip tone={!a.active ? "muted" : a.status === "running" ? "live" : a.status === "failed" ? "bad" : "muted"}>{a.active ? a.status : "removed from the team"}</Chip>
        <span className="tabular ml-auto text-xs text-muted-foreground">{team.length ? `${busy} of ${team.length} subagents busy` : "no subagents yet"}</span>
      </header>
      {task ? (
        <button type="button" onClick={() => open(task.id)} className="mt-2 block text-left text-sm hover:underline">
          <span className="eyebrow mr-2">{task.status === "waiting" ? "waiting on subagents" : "working on"}</span>
          <MathText text={task.title} />
        </button>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{a.lastActivity ?? "Nothing in progress."}</p>
      )}
      {task && a.lastActivity ? <p className="mt-1 text-xs text-muted-foreground">{a.lastActivity}</p> : null}
      {live ? (
        <div className="mt-3 border-t pt-2">
          <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="live-dot" /> {writing ? "writing now" : "reasoning now"}
          </p>
          <div className="flex max-h-36 flex-col-reverse overflow-hidden">
            <p className={`whitespace-pre-wrap break-words font-serif text-[0.93rem] leading-relaxed ${writing ? "" : "italic text-muted-foreground"}`}><MathText text={tailText(live, 1200)} /></p>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function NoteItem({ n }: { n: Note }) {
  const { open } = useRunCtx();
  const o = opening(n.text, 900);
  return (
    <article className="border-b py-3 last:border-b-0">
      <header className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Ref id={n.id} />
        <Who id={n.byAgent} className="text-xs" />
        <span>
          cycle {n.cycle} · {PHASE_NAMES[n.phase]} · {timeAgo(n.createdAt)}
        </span>
        {n.claimId ? <Ref id={n.claimId} /> : null}
      </header>
      <Markdown text={o.text} compact />
      {o.cut ? (
        <button type="button" onClick={() => open(n.id)} className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          Read the whole note
        </button>
      ) : null}
    </article>
  );
}

const MAP: { kinds: Note["kind"][]; title: string; empty: string }[] = [
  { kinds: ["understanding"], title: "Problem definition", empty: "No lead has written down its reading of the problem yet." },
  { kinds: ["prior_work"], title: "Prior work", empty: "No survey of prior work yet." },
  { kinds: ["approach"], title: "Approaches", empty: "No approach has been committed yet." },
  { kinds: ["decision"], title: "Decisions", empty: "No decision has been recorded yet." },
  { kinds: ["work", "note", "reply", "proposal", "system"], title: "Working notes", empty: "No working notes yet." },
];

function NoteGroup({ title, empty, notes }: { title: string; empty: string; notes: Note[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? notes : notes.slice(0, 3);
  return (
    <Section
      title={title}
      aside={
        notes.length > 3 ? (
          <button type="button" onClick={() => setAll((v) => !v)} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
            {all ? "Show the latest 3" : `Show all ${notes.length}`}
          </button>
        ) : (
          <span className="tabular text-xs text-muted-foreground">{notes.length || ""}</span>
        )
      }
    >
      {shown.length ? shown.map((n) => <NoteItem key={n.id} n={n} />) : <p className="py-2 text-sm text-muted-foreground">{empty}</p>}
    </Section>
  );
}

function ClaimCard({ c }: { c: Claim }) {
  const { data, open } = useRunCtx();
  const objections = standingObjections(data, c);
  const owed = data.obligation.filter((o) => o.claimId === c.id && o.status === "open");
  const o = opening(c.statement, 1400);
  return (
    <article className={`border-b py-4 last:border-b-0 ${c.status === "active" ? "" : "opacity-60"}`}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Ref id={c.id} />
        <LabelChip label={c.label} />
        <span className="eyebrow">{c.kind}</span>
        {c.answersGoal ? <Chip tone="live">answers the goal</Chip> : null}
        {c.stale ? (
          <Chip tone="warn" title={c.staleReason}>
            out of date
          </Chip>
        ) : null}
        {c.status !== "active" ? (
          <Chip tone="bad" title={c.statusReason}>
            {c.status}
          </Chip>
        ) : null}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Who id={c.authorId} className="text-xs" />
          <span className="tabular">rev {c.revision}</span>
        </span>
      </header>
      <div className="mt-2">
        <Markdown text={o.text} compact />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <button type="button" onClick={() => open(c.id)} className="underline underline-offset-2 hover:text-foreground">
          Argument, evidence and reviews
        </button>
        {c.proposedLabel !== c.label ? <span>author proposed “{LABEL_NAMES[c.proposedLabel]}”</span> : null}
        {c.dependsOn.length ? (
          <span className="flex flex-wrap items-center gap-1">
            depends on
            {c.dependsOn.map((d) => (
              <Ref key={d} id={d} />
            ))}
          </span>
        ) : null}
      </div>
      {c.status === "active" && c.blockers.length ? (
        <div className="mt-2 text-sm">
          <p className="eyebrow mb-0.5">Why it is not rated higher</p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            {c.blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {owed.length ? (
        <div className="mt-2 text-sm">
          <p className="eyebrow mb-0.5">Still to be shown</p>
          <ul className="space-y-1">
            {owed.map((x) => (
              <li key={x.id} className="flex gap-2">
                <Ref id={x.id} />
                <span>{x.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {objections.map((x) => (
        <aside key={x.id} className="gloss mt-3">
          <p className="mb-0.5 flex flex-wrap items-center gap-2 text-xs">
            <Ref id={x.id} />
            <span className="rubric">{x.severity} objection</span>
            <span className="text-muted-foreground">{x.status}</span>
            <Who id={x.byAgent} className="text-xs" />
          </p>
          <Markdown text={opening(x.text, 700).text} compact />
        </aside>
      ))}
    </article>
  );
}

export default function Research() {
  const { data, run } = useRunCtx();
  const [q, setQ] = useState("");
  const [hideDead, setHideDead] = useState(false);
  const goal = goalSummary(data);
  const counts = useMemo(() => labelCounts(data), [data]);
  const leads = useMemo(() => data.agent.filter((a) => a.kind === "lead").sort((a, b) => Number(b.active) - Number(a.active)), [data.agent]);
  const claims = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.claim
      .filter((c) => (!hideDead || c.status === "active") && (!needle || c.id.toLowerCase() === needle || c.statement.toLowerCase().includes(needle) || c.kind.includes(needle) || LABEL_NAMES[c.label].toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.answersGoal) - Number(a.answersGoal) || Number(b.status === "active") - Number(a.status === "active") || labelRank(b.label) - labelRank(a.label) || a.createdAt - b.createdAt);
  }, [data.claim, q, hideDead]);
  const groups = useMemo(() => MAP.map((g) => ({ ...g, notes: data.note.filter((n) => g.kinds.includes(n.kind)).reverse() })), [data.note]);

  return (
    <div className="mx-auto max-w-3xl space-y-10 px-5 py-6">
      <header>
        <p className="rubric mb-2">The problem</p>
        <div className="font-serif text-[1.08rem] leading-relaxed">
          <Markdown text={run.config.goal || "*No goal has been written yet.*"} />
        </div>
        {run.config.acceptance ? (
          <div className="mt-3 text-sm">
            <p className="eyebrow mb-0.5">Counts as done when</p>
            <Markdown text={run.config.acceptance} compact />
          </div>
        ) : null}
        <div className={`mt-4 rounded-md border p-3 text-sm ${goal.reached ? "border-ok/50 bg-ok-soft" : "bg-card/60"}`}>
          <p className="flex flex-wrap items-center gap-2">
            <span className="eyebrow">Required standard</span>
            <LabelChip label={run.config.standard} />
            {goal.claim ? <Ref id={goal.claim.id} /> : null}
          </p>
          <p className="mt-1.5">{goal.line}</p>
          {run.focus ? (
            <p className="mt-1.5 text-muted-foreground">
              <span className="eyebrow mr-2">Current focus</span>
              {run.focus}
            </p>
          ) : null}
        </div>
      </header>

      <Section title="Right now" aside={<span className="text-xs text-muted-foreground">{run.status === "running" ? `${PHASE_NAMES[run.phase]} · cycle ${run.cycle}` : words(run.status)}</span>}>
        {leads.length ? (
          <div className="grid gap-3">
            {leads.map((a) => (
              <LeadCard key={a.id} a={a} />
            ))}
          </div>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">The lead models appear here once the project has been started.</p>
        )}
      </Section>

      <Section
        title="Claims"
        aside={
          <span className="tabular flex flex-wrap justify-end gap-x-3 text-xs text-muted-foreground">
            {LABELS.filter((l) => counts[l]).map((l) => (
              <span key={l}>
                {counts[l]} {LABEL_NAMES[l].toLowerCase()}
              </span>
            ))}
          </span>
        }
      >
        {data.claim.length ? (
          <>
            <div className="no-print mb-1 flex flex-wrap items-center gap-3">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter claims by text, id or rating" className="h-8 max-w-xs text-sm" />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={hideDead} onChange={(e) => setHideDead(e.target.checked)} className="accent-[hsl(var(--rubric))]" />
                Hide refuted and withdrawn
              </label>
            </div>
            {claims.length ? claims.map((c) => <ClaimCard key={c.id} c={c} />) : <p className="py-3 text-sm text-muted-foreground">No claim matches that filter.</p>}
          </>
        ) : (
          <Empty title="No claims yet">Every statement the models are prepared to stand behind is recorded here with its rating, the reasons it is not rated higher, and any objection still standing against it.</Empty>
        )}
      </Section>

      {groups.map((g) => (
        <NoteGroup key={g.title} title={g.title} empty={g.empty} notes={g.notes} />
      ))}
    </div>
  );
}
