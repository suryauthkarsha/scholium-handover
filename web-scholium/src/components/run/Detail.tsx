// The detail panel: everything recorded about one item of the project, opened from any reference to it.
import { ArrowLeft } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { Chip, LabelChip, ModelTag, timeAgo, usd } from "@/components/bits";
import { Code, Markdown, MathText, Ref } from "@/components/Markdown";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { fmtDuration } from "@/engine/util";
import { fileSize } from "@/lib/files";
import { LABEL_NAMES, PHASE_NAMES, type Agent, type Claim, type Evidence, type Objection } from "@/shared/types";

import { describe, find, useRunCtx, Who, words, type Found } from "./ctx";
import { Ext, safeUrl, tokens } from "./Records";
import { Transcript } from "./Transcript";

const Block = ({ title, children }: { title: string; children: ReactNode }) => (
  <section>
    <p className="eyebrow mb-1.5">{title}</p>
    {children}
  </section>
);

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {shown.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-words">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

const Refs = ({ ids }: { ids: string[] }) =>
  ids.length ? (
    <span className="flex flex-wrap gap-1">
      {ids.map((i) => (
        <Ref key={i} id={i} />
      ))}
    </span>
  ) : null;
const Bullets = ({ items }: { items: string[] }) => (
  <ul className="list-disc space-y-1 pl-5 text-sm">
    {items.map((t, i) => (
      <li key={i}>{t}</li>
    ))}
  </ul>
);
const QUOTE = { verified: "ok", approximate: "warn", not_found: "bad", unverifiable: "muted" } as const;
const QUOTE_TEXT = { verified: "quotation found in the source", approximate: "quotation only approximately matches the source", not_found: "quotation NOT found in the source", unverifiable: "quotation could not be checked" } as const;

function EvidenceItem({ e }: { e: Evidence }) {
  return (
    <div className="border-b py-2.5 last:border-b-0">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Ref id={e.id} />
        <Chip tone={e.stance === "supports" ? "ok" : "bad"}>{e.stance}</Chip>
        <span className="eyebrow">{e.kind}</span>
        {e.quoteStatus ? <Chip tone={QUOTE[e.quoteStatus]}>{QUOTE_TEXT[e.quoteStatus]}</Chip> : null}
        <Refs ids={[e.sourceId, e.experimentId, e.leanCheckId].filter((x): x is string => !!x)} />
        <Who id={e.byAgent} />
        <span>for revision {e.revision}</span>
      </p>
      <div className="mt-1">
        <Markdown text={e.summary} compact />
      </div>
      {e.quote ? (
        <blockquote className="mt-1 border-l-2 pl-3 font-serif text-[0.93rem] italic">
          “{e.quote}”{e.locator ? <span className="not-italic text-muted-foreground"> — {e.locator}</span> : null}
        </blockquote>
      ) : null}
    </div>
  );
}

function ObjectionItem({ x }: { x: Objection }) {
  return (
    <aside className="gloss mb-3">
      <p className="mb-0.5 flex flex-wrap items-center gap-2 text-xs">
        <Ref id={x.id} />
        <span className="rubric">{x.severity}</span>
        <span className="text-muted-foreground">
          {x.status} · against revision {x.revision}
        </span>
        <Who id={x.byAgent} />
      </p>
      <Markdown text={x.text} compact />
      {x.proposedExperiment ? <p className="mt-1 text-sm text-muted-foreground">Proposed test: {x.proposedExperiment}</p> : null}
      {x.responses.map((r, i) => (
        <div key={i} className="mt-2 border-l pl-3">
          <p className="text-xs text-muted-foreground">
            {r.kind === "concede" ? "conceded by" : r.kind === "resolution" ? "resolved by" : "reply from"} <Who id={r.by} /> · {timeAgo(r.at)}
          </p>
          <Markdown text={r.text} compact />
        </div>
      ))}
    </aside>
  );
}

function ClaimBody({ c }: { c: Claim }) {
  const { data } = useRunCtx();
  const of = <T extends { claimId: string }>(list: T[]): T[] => list.filter((x) => x.claimId === c.id);
  const ev = of(data.evidence);
  const objections = of(data.objection);
  const owed = of(data.obligation);
  const reviews = of(data.review);
  const lean = of(data.leancheck);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <LabelChip label={c.label} />
        <span className="eyebrow">{c.kind}</span>
        {c.answersGoal ? <Chip tone="live">answers the goal</Chip> : null}
        {c.stale ? <Chip tone="warn">out of date</Chip> : null}
        {c.status !== "active" ? <Chip tone="bad">{c.status}</Chip> : null}
      </div>
      <Block title="Statement">
        <Markdown text={c.statement} />
      </Block>
      {c.blockers.length ? (
        <Block title="Why it is not rated higher">
          <Bullets items={c.blockers} />
        </Block>
      ) : null}
      <Facts
        rows={[
          ["Author", <Who id={c.authorId} />],
          ["Rating the author proposed", LABEL_NAMES[c.proposedLabel]],
          ["Rests on", words(c.basis === "memory" ? "the model's memory (unverified)" : c.basis)],
          ["Revision", `${c.revision} · cycle ${c.cycle}, ${PHASE_NAMES[c.phase]}`],
          ["Depends on", c.dependsOn.length ? <Refs ids={c.dependsOn} /> : undefined],
          ["Out of date because", c.staleReason],
          ["Reason for status", c.statusReason],
        ]}
      />
      {c.argument ? (
        <Block title="Argument">
          <Markdown text={c.argument} />
        </Block>
      ) : null}
      <Block title={`Evidence · ${ev.length}`}>{ev.length ? ev.map((e) => <EvidenceItem key={e.id} e={e} />) : <p className="text-sm text-muted-foreground">No evidence is attached to this claim.</p>}</Block>
      {objections.length ? <Block title={`Objections · ${objections.length}`}>{objections.map((x) => <ObjectionItem key={x.id} x={x} />)}</Block> : null}
      {owed.length ? (
        <Block title="Proof obligations">
          {owed.map((o) => (
            <p key={o.id} className="mb-1.5 text-sm">
              <Ref id={o.id} /> <Chip tone={o.status === "open" ? "warn" : "ok"}>{o.status}</Chip> {o.text}
              {o.resolution ? <span className="block text-muted-foreground">Resolved: {o.resolution}</span> : null}
            </p>
          ))}
        </Block>
      ) : null}
      {reviews.length ? (
        <Block title={`Reviews · ${reviews.length}`}>
          {reviews.map((r) => (
            <div key={r.id} className="border-b py-2.5 last:border-b-0">
              <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Ref id={r.id} />
                <Chip tone={r.verdict === "accept" ? "ok" : r.verdict === "reject" ? "bad" : "warn"}>{words(r.verdict)}</Chip>
                <Who id={r.byAgent} />
                <ModelTag model={r.byModel} />
                <span>
                  of revision {r.revision}
                  {r.revision !== c.revision ? " (an earlier revision)" : ""}
                </span>
              </p>
              <Markdown text={r.summary} compact />
            </div>
          ))}
        </Block>
      ) : null}
      {lean.length ? (
        <Block title="Formal checks">
          <Refs ids={lean.map((l) => l.id)} />
        </Block>
      ) : null}
      {c.history.length ? (
        <Block title="History">
          <ul className="space-y-1 text-sm text-muted-foreground">
            {c.history.map((h, i) => (
              <li key={i}>
                rev {h.revision} · {timeAgo(h.at)} · <Who id={h.by} /> — {h.note}
              </li>
            ))}
          </ul>
        </Block>
      ) : null}
    </>
  );
}

function AgentBody({ a }: { a: Agent }) {
  const { data, open } = useRunCtx();
  const tasks = data.task.filter((t) => t.agentId === a.id);
  const made = data.agent.filter((x) => x.parentId === a.id);
  const g = a.assignment;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <ModelTag model={a.model} full />
        <Chip tone={a.status === "running" ? "live" : a.status === "failed" ? "bad" : a.status === "completed" ? "ok" : "muted"}>{a.kind === "lead" && !a.active ? "removed from the team" : a.status}</Chip>
        <span className="eyebrow">{a.kind}</span>
      </div>
      <Facts
        rows={[
          ["Role", a.role],
          ["Created by", a.parentId ? <Who id={a.parentId} /> : undefined],
          ["Cost", `${usd(a.costUsd)} over ${a.turns} ${a.turns === 1 ? "turn" : "turns"}`],
          ["Tokens", tokens(a.usage)],
          ["Latest", a.lastActivity],
          ["Error", a.error ? <span className="text-destructive">{a.error}</span> : undefined],
        ]}
      />
      {g ? (
        <Block title="Assignment">
          <Markdown text={g.question} compact />
          <div className="mt-2">
            <Facts
              rows={[
                ["Expected output", g.expectedOutput],
                ["Finished when", g.completionCriteria],
                ["Limits", `${g.maxTurns} turns · ${usd(g.budgetUsd)}`],
                ["Waits for", g.dependencies.length ? <Refs ids={g.dependencies} /> : undefined],
                ["Sources given", g.sources.length ? <Refs ids={g.sources} /> : undefined],
              ]}
            />
          </div>
          {g.context ? (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-xs text-muted-foreground">Context it was given</summary>
              <Markdown text={g.context} compact />
            </details>
          ) : null}
        </Block>
      ) : null}
      {a.result ? (
        <Block title="What it reported">
          <Markdown text={a.result.answer} compact />
          {a.result.findings.length ? <Bullets items={a.result.findings} /> : null}
          <div className="mt-2">
            <Facts rows={[["Confidence", a.result.confidence], ["Unresolved", a.result.unresolved.length ? <Bullets items={a.result.unresolved} /> : undefined], ["Claims", <Refs ids={a.result.claimIds} />], ["Experiments", <Refs ids={a.result.experimentIds} />]]} />
          </div>
        </Block>
      ) : null}
      {a.review ? (
        <Block title="Review of this work">
          <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Chip tone={a.review.verdict === "accept" ? "ok" : a.review.verdict === "reject" ? "bad" : "warn"}>{words(a.review.verdict)}</Chip>
            <Who id={a.review.byAgent} />
            <ModelTag model={a.review.byModel} />
          </p>
          {a.review.issues.length ? <Bullets items={a.review.issues} /> : null}
        </Block>
      ) : null}
      <Block title={`Tasks · ${tasks.length}`}>
        {tasks.map((t) => (
          <button key={t.id} type="button" onClick={() => open(t.id)} className="flex w-full items-center gap-2 border-b py-1.5 text-left text-sm last:border-b-0 hover:bg-secondary/50">
            <span className="ref">{t.id}</span>
            <span className="min-w-0 flex-1 truncate"><MathText text={t.title} /></span>
            <span className="text-xs text-muted-foreground">
              {t.status} · {t.turns} turns
            </span>
          </button>
        ))}
      </Block>
      {made.length ? (
        <Block title={`Subagents it created · ${made.length}`}>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {made.map((x) => (
              <Who key={x.id} id={x.id} />
            ))}
          </div>
        </Block>
      ) : null}
    </>
  );
}

function Body({ f }: { f: Found }) {
  switch (f.kind) {
    case "claim":
      return <ClaimBody c={f.item} />;
    case "agent":
      return <AgentBody a={f.item} />;
    case "task": {
      const t = f.item;
      return (
        <>
          <Facts rows={[["Agent", <Who id={t.agentId} />], ["Kind", words(t.type)], ["Status", t.status], ["When", `cycle ${t.cycle}, ${PHASE_NAMES[t.phase]}`], ["Turns", `${t.turns} of at most ${t.maxTurns}`], ["Cost", usd(t.costUsd)], ["Error", t.error ? <span className="text-destructive">{t.error}</span> : undefined]]} />
          <Block title="Transcript">
            <Transcript taskId={t.id} />
          </Block>
        </>
      );
    }
    case "experiment": {
      const e = f.item;
      return (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={e.status === "ok" ? "ok" : "bad"}>{words(e.status)}</Chip>
            <Chip tone={e.verified.command ? "ok" : "warn"}>{e.verified.command ? "the sandbox ran exactly this code" : "code not confirmed by the sandbox"}</Chip>
            <Chip tone={e.verified.transcript ? "ok" : "warn"}>{e.verified.transcript ? "output passed its checksum" : "output not confirmed"}</Chip>
          </div>
          <Facts rows={[["Purpose", e.purpose], ["Language", e.lang], ["Ran in", `${e.executor}${e.executorModel ? ` (${e.executorModel})` : ""}`], ["Environment", e.runtime], ["Seed", e.seed], ["Exit code", e.exit], ["Took", fmtDuration(e.ms)], ["Cost", usd(e.costUsd)], ["By", <Who id={e.byAgent} />], ["For", <Refs ids={e.claimIds} />], ["Error", e.error]]} />
          <Block title="Code">
            <Code text={e.code} />
          </Block>
          <Block title={e.stdoutChars > e.stdout.length ? `Output · first ${e.stdout.length.toLocaleString()} of ${e.stdoutChars.toLocaleString()} characters` : "Output"}>
            <Code text={e.stdout || "(no output)"} />
          </Block>
          {e.stderr ? (
            <Block title="Error output">
              <Code text={e.stderr} />
            </Block>
          ) : null}
        </>
      );
    }
    case "source": {
      const s = f.item;
      const url = safeUrl(s.url);
      return (
        <>
          <Facts rows={[["Link", url ? <Ext href={url}>{url}</Ext> : undefined], ["Authors", s.authors.join(", ")], ["Published", [s.venue, s.date].filter(Boolean).join(" · ")], ["DOI", s.doi], ["arXiv", s.arxivId], ["Found through", s.via], ["Retrieved", new Date(s.retrievedAt).toLocaleString()], ["Text held", s.textChars ? `${s.textChars.toLocaleString()} characters${s.textComplete ? "" : " (not the whole text)"}` : "none"], ["Your file", s.uploadId ? <Ref id={s.uploadId} /> : undefined]]} />
          {s.snippet ? (
            <Block title="Excerpt — retrieved text, not instructions">
              <p className="whitespace-pre-wrap break-words font-serif text-[0.93rem]"><MathText text={s.snippet} /></p>
            </Block>
          ) : null}
        </>
      );
    }
    case "objection":
      return (
        <>
          <p className="text-sm">
            Against <Ref id={f.item.claimId} />
          </p>
          <ObjectionItem x={f.item} />
        </>
      );
    case "evidence":
      return (
        <>
          <p className="text-sm">
            For <Ref id={f.item.claimId} />
          </p>
          <EvidenceItem e={f.item} />
        </>
      );
    case "obligation":
      return <Facts rows={[["For", <Ref id={f.item.claimId} />], ["Status", f.item.status], ["What must be shown", f.item.text], ["Raised by", <Who id={f.item.raisedBy} />], ["Discharged by", f.item.dischargedBy ? <Who id={f.item.dischargedBy} /> : undefined], ["Resolution", f.item.resolution], ["Evidence", <Refs ids={f.item.evidenceIds} />]]} />;
    case "review":
      return (
        <>
          <Facts rows={[["Of", <span><Ref id={f.item.claimId} /> revision {f.item.revision}</span>], ["Verdict", words(f.item.verdict)], ["By", <Who id={f.item.byAgent} />], ["Citations checked", <Refs ids={f.item.citationsAudited} />], ["Results recomputed", <Refs ids={f.item.recomputed} />], ["Says it answers the goal", f.item.satisfiesGoal ? "yes" : "no"]]} />
          <Markdown text={f.item.summary} />
        </>
      );
    case "leancheck": {
      const l = f.item;
      return (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={l.ok && !l.hasSorry ? "ok" : "bad"}>{l.ok ? (l.hasSorry ? "compiled, but contains sorry" : "compiled") : "did not compile"}</Chip>
            <Chip tone={l.faithfulness ? (l.faithfulness.faithful ? "ok" : "bad") : "warn"}>{l.faithfulness ? (l.faithfulness.faithful ? "statement judged faithful" : "statement judged NOT faithful") : "faithfulness not reviewed"}</Chip>
          </div>
          <Facts rows={[["For", <span><Ref id={l.claimId} /> revision {l.revision}</span>], ["Versions", l.versions], ["Axioms used", l.axioms.join(", ")], ["Beyond the standard ones", l.nonStandardAxioms.join(", ")], ["Declares its own axioms", l.declaresAxioms ? "yes" : undefined], ["Faithfulness review", l.faithfulness ? <span><Who id={l.faithfulness.byAgent} /> — {l.faithfulness.notes}</span> : undefined], ["By", <Who id={l.byAgent} />]]} />
          <Block title="Lean source">
            <Code text={l.source} />
          </Block>
          {l.errors.length || l.warnings.length ? (
            <Block title="Messages from Lean">
              <Code text={[...l.errors, ...l.warnings].join("\n")} />
            </Block>
          ) : null}
          {l.log ? (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">Full log</summary>
              <Code text={l.log} className="mt-1" />
            </details>
          ) : null}
        </>
      );
    }
    case "artifact":
      return (
        <>
          <Facts rows={[["File", <span className="font-mono text-xs">{f.item.filename}</span>], ["Version", f.item.version], ["By", <Who id={f.item.byAgent} />], ["About", <Refs ids={f.item.claimIds} />], ["From", f.item.experimentId ? <Ref id={f.item.experimentId} /> : undefined]]} />
          {f.item.kind === "report" || f.item.kind === "document" || /\.(md|markdown)$/i.test(f.item.filename) ? <Markdown text={f.item.content} /> : <Code text={f.item.content} />}
        </>
      );
    case "note":
      return (
        <>
          <Facts rows={[["By", <Who id={f.item.byAgent} />], ["When", `cycle ${f.item.cycle}, ${PHASE_NAMES[f.item.phase]} · ${timeAgo(f.item.createdAt)}`], ["About", f.item.claimId ? <Ref id={f.item.claimId} /> : undefined]]} />
          <Markdown text={f.item.text} />
        </>
      );
    case "upload":
      return <Facts rows={[["Name", f.item.name], ["Size", fileSize(f.item.size)], ["Pages", f.item.pages], ["Readable text", `${f.item.textChars.toLocaleString()} characters`], ["SHA-256", <span className="break-all font-mono text-xs">{f.item.sha256}</span>], ["Listed as", f.item.sourceId ? <Ref id={f.item.sourceId} /> : undefined], ["Download", "from Evidence → Files"]]} />;
    case "instruction":
      return (
        <>
          <p className="whitespace-pre-wrap break-words text-sm"><MathText text={f.item.text} /></p>
          <Facts rows={[["Status", f.item.status], ["Sent", new Date(f.item.createdAt).toLocaleString()], ["Delivered to", f.item.deliveries.length ? <span className="flex flex-wrap gap-x-3">{f.item.deliveries.map((d, i) => <span key={i}><Who id={d.agentId} /> in <Ref id={d.taskId} /></span>)}</span> : undefined]]} />
        </>
      );
    case "checkpoint":
      return (
        <>
          <Facts rows={[["Saved", `${new Date(f.item.at).toLocaleString()} · cycle ${f.item.cycle}, ${PHASE_NAMES[f.item.phase]}`], ["Reason", f.item.reason], ["Spent by then", usd(f.item.spendUsd)], ["Branch", "from Evidence → Checkpoints"]]} />
          {f.item.summary ? <Markdown text={f.item.summary} compact /> : null}
        </>
      );
    case "email":
      return <Facts rows={[["Kind", f.item.kind], ["To", f.item.to], ["Subject", f.item.subject], ["Status", f.item.status], ["Detail", f.item.detail], ["When", new Date(f.item.at).toLocaleString()]]} />;
    default:
      return <p className="text-sm text-muted-foreground">Nothing more is recorded about this item.</p>;
  }
}

export default function Detail({ refId, onBack, onClose }: { refId: string | null; onBack?: () => void; onClose: () => void }) {
  const { data } = useRunCtx();
  const f = refId ? find(data, refId) : undefined;
  const title = f?.kind === "agent" ? f.item.name : (refId ?? "");
  return (
    <Sheet open={refId !== null} onOpenChange={(o) => (o ? undefined : onClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
        <SheetHeader className="space-y-1 border-b px-5 py-4 text-left">
          {onBack ? (
            <button type="button" onClick={onBack} className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3 w-3" /> Back
            </button>
          ) : null}
          <SheetTitle className="pr-8 font-serif text-xl font-medium">
            {f ? <span className="eyebrow mr-2 align-middle">{words(f.kind === "leancheck" ? "lean check" : f.kind)}</span> : null}
            {title}
          </SheetTitle>
          <SheetDescription className="line-clamp-2">{refId ? (describe(data, refId) ?? "This item is not in the project's records.") : ""}</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-5 py-5">{f ? <Body f={f} /> : null}</div>
      </SheetContent>
    </Sheet>
  );
}
