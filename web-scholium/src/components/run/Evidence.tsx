// Evidence and verification: how well each claim is supported, and everything that support rests on.
import { useMemo, useState } from "react";

import { Chip, Empty, LabelChip, ModelTag, Section, timeAgo, usd } from "@/components/bits";
import { MathText, Ref } from "@/components/Markdown";
import { labelCounts, standingObjections } from "@/engine/report";
import { fmtDuration } from "@/engine/util";
import { LABELS, LABEL_NAMES } from "@/shared/types";

import { brief, useRunCtx, Who, words } from "./ctx";
import { Calls, Checkpoints, Ext, Files, none, Row, safeUrl } from "./Records";

function Matrix() {
  const { data, open } = useRunCtx();
  const counts = useMemo(() => labelCounts(data), [data]);
  const rows = useMemo(
    () =>
      data.claim.map((c) => {
        const ev = data.evidence.filter((e) => e.claimId === c.id);
        const rv = data.review.filter((r) => r.claimId === c.id && r.revision === c.revision);
        const lean = data.leancheck.filter((l) => l.claimId === c.id).at(-1);
        return {
          c,
          pro: ev.filter((e) => e.stance === "supports").length,
          con: ev.filter((e) => e.stance === "contradicts").length,
          quotes: ev.filter((e) => e.quoteStatus === "verified").length,
          runs: data.experiment.filter((x) => x.claimIds.includes(c.id)),
          accept: rv.filter((r) => r.verdict === "accept").length,
          reject: rv.filter((r) => r.verdict === "reject").length,
          unsure: rv.filter((r) => r.verdict === "cannot_assess").length,
          standing: standingObjections(data, c).length,
          owed: data.obligation.filter((o) => o.claimId === c.id && o.status === "open").length,
          lean,
        };
      }),
    [data],
  );
  if (!rows.length) return <Empty title="Nothing to verify yet">Each claim appears here with the evidence for and against it, the reviews of its current revision, and what still stands in its way.</Empty>;
  const th = "eyebrow whitespace-nowrap px-2 py-2 text-left font-medium";
  const td = "tabular whitespace-nowrap px-2 py-2 align-top";
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        {LABELS.map((l) => (
          <div key={l} className={`rounded-sm border px-3 py-1.5 ${counts[l] ? "bg-card/60" : "opacity-50"}`}>
            <p className="tabular font-serif text-xl leading-none">{counts[l]}</p>
            <p className="mt-1 text-xs text-muted-foreground">{LABEL_NAMES[l]}</p>
          </div>
        ))}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        Ratings are assigned by the platform from what is recorded here, not by the author of the claim. “Model-reviewed” means other models accepted the argument; it is not a formal proof. Only “Formally checked” means a proof assistant compiled it.
      </p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[46rem] border-collapse text-sm">
          <thead className="border-b bg-card/60">
            <tr>
              <th className={th}>Claim</th>
              <th className={th}>Rating</th>
              <th className={th}>Evidence</th>
              <th className={th}>Experiments</th>
              <th className={th}>Reviews of this revision</th>
              <th className={th}>Standing objections</th>
              <th className={th}>Still owed</th>
              <th className={th}>Lean</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.c.id} className={`border-b last:border-b-0 ${r.c.status === "active" ? "" : "opacity-55"}`}>
                <td className="max-w-[22rem] px-2 py-2 align-top">
                  <Ref id={r.c.id} />{" "}
                  <button type="button" onClick={() => open(r.c.id)} className="text-left hover:underline">
                    <MathText text={brief(r.c.statement, 110)} />
                  </button>
                  {r.c.status !== "active" ? <span className="ml-1 text-xs text-destructive">{r.c.status}</span> : null}
                  {r.c.stale ? <span className="ml-1 text-xs text-warn">out of date</span> : null}
                </td>
                <td className={td}>
                  <LabelChip label={r.c.label} />
                </td>
                <td className={td}>
                  {r.pro} for · <span className={r.con ? "text-destructive" : ""}>{r.con} against</span>
                  {r.quotes ? <span className="block text-xs text-muted-foreground">{r.quotes} quotes matched to the source</span> : null}
                </td>
                <td className={td}>
                  {r.runs.length ? `${r.runs.filter((x) => x.status === "ok").length} of ${r.runs.length} ran` : "—"}
                  {r.runs.length ? <span className="block text-xs text-muted-foreground">{r.runs.filter((x) => x.verified.command && x.verified.transcript).length} confirmed by the sandbox</span> : null}
                </td>
                <td className={td}>
                  {r.accept + r.reject + r.unsure ? (
                    <>
                      {r.accept} accept · <span className={r.reject ? "text-destructive" : ""}>{r.reject} reject</span>
                      {r.unsure ? ` · ${r.unsure} could not assess` : ""}
                    </>
                  ) : (
                    "none yet"
                  )}
                </td>
                <td className={`${td} ${r.standing ? "font-medium text-[hsl(var(--rubric))]" : ""}`}>{r.standing || "—"}</td>
                <td className={td}>{r.owed || "—"}</td>
                <td className={td}>{r.lean ? <Chip tone={r.lean.ok && !r.lean.hasSorry ? "ok" : "bad"}>{r.lean.ok ? (r.lean.hasSorry ? "has sorry" : `compiled · rev ${r.lean.revision}`) : "failed"}</Chip> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Sources() {
  const { data } = useRunCtx();
  if (!data.source.length) return none("No source has been retrieved yet. Sources are listed only when a retrieval tool actually returned them; nothing is cited from memory.");
  return (
    <Section title="Sources" aside={<span className="tabular text-xs text-muted-foreground">{data.source.length}</span>}>
      <p className="mb-2 text-xs text-muted-foreground">Retrieved pages and papers are treated as material to check, never as instructions. A quotation counts as verified only when it was found in the text held here.</p>
      <ul>
        {data.source.map((s) => {
          const url = safeUrl(s.url);
          return (
            <Row
              key={s.id}
              id={s.id}
              chips={<span className="eyebrow">{s.kind}</span>}
              meta={
                <>
                  <span>found through {s.via}</span>
                  <span>retrieved {new Date(s.retrievedAt).toLocaleString()}</span>
                  <span>{s.textChars ? `${s.textChars.toLocaleString()} characters held${s.textComplete ? "" : " (not the whole text)"}` : "no text held, so quotations cannot be checked"}</span>
                  {s.doi ? <Ext href={`https://doi.org/${encodeURI(s.doi)}`}>doi:{s.doi}</Ext> : null}
                  {s.arxivId ? <Ext href={`https://arxiv.org/abs/${encodeURI(s.arxivId)}`}>arXiv:{s.arxivId}</Ext> : null}
                  {s.byAgent ? <Who id={s.byAgent} /> : null}
                </>
              }
            >
              {url ? <Ext href={url}><MathText text={s.title || url} /></Ext> : <MathText text={s.title} />}
              {s.authors.length || s.venue || s.date ? (
                <span className="block text-muted-foreground">{[s.authors.slice(0, 4).join(", ") + (s.authors.length > 4 ? " et al." : ""), s.venue, s.date].filter(Boolean).join(" · ")}</span>
              ) : null}
            </Row>
          );
        })}
      </ul>
    </Section>
  );
}

function Experiments() {
  const { data, open } = useRunCtx();
  if (!data.experiment.length) return none("No computation has been run yet.");
  return (
    <Section title="Experiments" aside={<span className="tabular text-xs text-muted-foreground">{data.experiment.length}</span>}>
      <p className="mb-2 text-xs text-muted-foreground">Code, output, seed, runtime and environment are saved for every run. A computation is evidence about the cases it covered; it is not a proof.</p>
      <ul>
        {[...data.experiment].reverse().map((e) => (
          <Row
            key={e.id}
            id={e.id}
            chips={
              <>
                <Chip tone={e.status === "ok" ? "ok" : "bad"}>{words(e.status)}</Chip>
                <span className="eyebrow">{e.lang}</span>
                <Chip tone={e.verified.command ? "ok" : "warn"}>{e.verified.command ? "ran exactly this code" : "code not confirmed"}</Chip>
                <Chip tone={e.verified.transcript ? "ok" : "warn"}>{e.verified.transcript ? "output checksum matched" : "output not confirmed"}</Chip>
              </>
            }
            meta={
              <>
                <span>
                  in {e.executor}
                  {e.runtime ? ` · ${brief(e.runtime, 60)}` : ""}
                </span>
                {e.seed !== undefined ? <span>seed {e.seed}</span> : null}
                <span>{fmtDuration(e.ms)}</span>
                <span>{usd(e.costUsd)}</span>
                <Who id={e.byAgent} />
                {e.claimIds.map((c) => (
                  <Ref key={c} id={c} />
                ))}
              </>
            }
          >
            <button type="button" onClick={() => open(e.id)} className="text-left hover:underline">
              {e.purpose}
            </button>
            {e.error ? <span className="mt-0.5 block font-mono text-xs text-destructive">{brief(e.error, 300)}</span> : null}
          </Row>
        ))}
      </ul>
    </Section>
  );
}

function Formal() {
  const { data, run, open } = useRunCtx();
  const status = run.toolStatus.lean;
  return (
    <Section title="Formal checks" aside={<span className="tabular text-xs text-muted-foreground">{data.leancheck.length || ""}</span>}>
      <p className="mb-2 text-xs text-muted-foreground">
        {!run.config.tools.lean ? "Lean is switched off for this project." : status ? (status.ok ? `Lean checker: ${status.detail}` : `Lean checker unavailable: ${status.detail}`) : "The Lean checker has not been tried yet in this project."}
      </p>
      {data.leancheck.length ? (
        <ul>
          {[...data.leancheck].reverse().map((l) => (
            <Row
              key={l.id}
              id={l.id}
              chips={
                <>
                  <Chip tone={l.ok && !l.hasSorry && !l.nonStandardAxioms.length ? "ok" : "bad"}>{l.ok ? (l.hasSorry ? "compiled, but contains sorry" : "compiled") : "did not compile"}</Chip>
                  {l.nonStandardAxioms.length ? <Chip tone="bad">extra axioms: {l.nonStandardAxioms.join(", ")}</Chip> : null}
                  <Chip tone={l.faithfulness ? (l.faithfulness.faithful ? "ok" : "bad") : "warn"}>{l.faithfulness ? (l.faithfulness.faithful ? "statement judged faithful to the claim" : "statement judged NOT faithful") : "faithfulness not reviewed"}</Chip>
                </>
              }
              meta={
                <>
                  <span>
                    for <Ref id={l.claimId} /> revision {l.revision}
                  </span>
                  <span>{brief(l.versions, 90) || "versions not reported"}</span>
                  <Who id={l.byAgent} />
                  <span>{timeAgo(l.createdAt)}</span>
                </>
              }
            >
              <button type="button" onClick={() => open(l.id)} className="text-left font-mono text-[0.85rem] hover:underline">
                {l.theoremName}
              </button>
              {l.errors[0] ? <span className="mt-0.5 block font-mono text-xs text-destructive">{brief(l.errors[0], 300)}</span> : null}
            </Row>
          ))}
        </ul>
      ) : (
        none("Nothing has been checked in Lean in this project.")
      )}
    </Section>
  );
}

function Reviews() {
  const { data } = useRunCtx();
  const open = (s: string) => s === "open" || s === "unresolved" || s === "answered";
  const objections = useMemo(() => [...data.objection].sort((a, b) => Number(open(b.status)) - Number(open(a.status)) || b.updatedAt - a.updatedAt), [data.objection]);
  return (
    <div className="space-y-8">
      <Section title="Objections" aside={<span className="tabular text-xs text-muted-foreground">{objections.length || ""}</span>}>
        {objections.length ? (
          <ul>
            {objections.map((x) => (
              <Row
                key={x.id}
                id={x.id}
                chips={
                  <>
                    <span className={x.severity === "minor" ? "eyebrow" : "rubric"}>{x.severity}</span>
                    <Chip tone={open(x.status) ? "warn" : x.status === "conceded" ? "bad" : "ok"}>{x.status}</Chip>
                  </>
                }
                meta={
                  <>
                    <span>
                      against <Ref id={x.claimId} /> revision {x.revision}
                    </span>
                    <Who id={x.byAgent} />
                    <ModelTag model={x.byModel} />
                    <span>{x.responses.length ? `${x.responses.length} ${x.responses.length === 1 ? "reply" : "replies"}` : "no reply yet"}</span>
                    {x.experimentId ? <Ref id={x.experimentId} /> : null}
                  </>
                }
              >
                <div className="gloss">{brief(x.text, 420)}</div>
              </Row>
            ))}
          </ul>
        ) : (
          none("No objection has been raised yet.")
        )}
      </Section>
      <Section title="Proof obligations" aside={<span className="tabular text-xs text-muted-foreground">{data.obligation.length || ""}</span>}>
        {data.obligation.length ? (
          <ul>
            {data.obligation.map((o) => (
              <Row
                key={o.id}
                id={o.id}
                chips={<Chip tone={o.status === "open" ? "warn" : "ok"}>{o.status}</Chip>}
                meta={
                  <>
                    <span>
                      for <Ref id={o.claimId} />
                    </span>
                    <span>
                      raised by <Who id={o.raisedBy} />
                    </span>
                    {o.evidenceIds.map((v) => (
                      <Ref key={v} id={v} />
                    ))}
                  </>
                }
              >
                {brief(o.text, 420)}
                {o.resolution ? <span className="mt-0.5 block text-muted-foreground">Resolved: {brief(o.resolution, 320)}</span> : null}
              </Row>
            ))}
          </ul>
        ) : (
          none("No step has been flagged as still needing proof.")
        )}
      </Section>
      <Section title="Reviews" aside={<span className="tabular text-xs text-muted-foreground">{data.review.length || ""}</span>}>
        {data.review.length ? (
          <ul>
            {[...data.review].reverse().map((r) => (
              <Row
                key={r.id}
                id={r.id}
                chips={<Chip tone={r.verdict === "accept" ? "ok" : r.verdict === "reject" ? "bad" : "warn"}>{words(r.verdict)}</Chip>}
                meta={
                  <>
                    <span>
                      of <Ref id={r.claimId} /> revision {r.revision}
                    </span>
                    <Who id={r.byAgent} />
                    <ModelTag model={r.byModel} />
                    <span>{r.citationsAudited.length} citations checked</span>
                    <span>{r.recomputed.length} results recomputed</span>
                    {r.satisfiesGoal ? <span>says it answers the goal</span> : null}
                  </>
                }
              >
                <MathText text={brief(r.summary, 420)} />
              </Row>
            ))}
          </ul>
        ) : (
          none("No claim has been reviewed yet.")
        )}
      </Section>
    </div>
  );
}

const TABS = ["Verification", "Sources", "Experiments", "Formal checks", "Reviews", "Files", "Model calls", "Checkpoints"] as const;
type Tab = (typeof TABS)[number];

export default function Evidence() {
  const { data } = useRunCtx();
  const [tab, setTab] = useState<Tab>("Verification");
  const n: Partial<Record<Tab, number>> = {
    Sources: data.source.length,
    Experiments: data.experiment.length,
    "Formal checks": data.leancheck.length,
    Reviews: data.review.length + data.objection.length,
    Files: data.upload.length + data.artifact.length,
    Checkpoints: data.checkpoint.length,
  };
  return (
    <div className="mx-auto max-w-5xl px-5 py-6">
      <nav className="no-print mb-5 flex flex-wrap gap-1.5" aria-label="Evidence sections">
        {TABS.map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t} className={`press rounded-sm border px-2.5 py-1 text-xs ${tab === t ? "border-foreground bg-foreground text-background" : "bg-background hover:border-foreground/50"}`}>
            {t}
            {n[t] ? <span className="tabular ml-1.5 opacity-70">{n[t]}</span> : null}
          </button>
        ))}
      </nav>
      {tab === "Verification" ? <Matrix /> : tab === "Sources" ? <Sources /> : tab === "Experiments" ? <Experiments /> : tab === "Formal checks" ? <Formal /> : tab === "Reviews" ? <Reviews /> : tab === "Files" ? <Files /> : tab === "Model calls" ? <Calls /> : <Checkpoints />}
    </div>
  );
}
