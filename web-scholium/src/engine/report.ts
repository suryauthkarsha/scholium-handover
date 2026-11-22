// Deterministic reports, exports and email digests built from the ledger. Runs in the Worker and in the browser.
import { normalizeMath } from "../shared/math";
import { MODELS } from "../shared/models";
import {
  ENTITY_KINDS,
  type Claim,
  type EntityKind,
  type EntityMap,
  type Label,
  LABEL_NAMES,
  LABELS,
  type Objection,
  PHASE_NAMES,
  type RunState,
  type Snapshot,
} from "../shared/types";
import { fmtDuration, fmtUsd, oneLine } from "./util";

export type Data = { [K in EntityKind]: EntityMap[K][] };

export function dataFrom(s: Snapshot): Data {
  const d = {} as Record<EntityKind, unknown[]>;
  for (const k of ENTITY_KINDS) d[k] = (s[k] as unknown[] | undefined) ?? [];
  return d as Data;
}

const byNum = <T extends { id: string }>(list: T[]): T[] => [...list].sort((a, b) => Number(a.id.replace(/\D+/g, "")) - Number(b.id.replace(/\D+/g, "")));
const STANDING = new Set<Objection["status"]>(["open", "answered", "unresolved"]);

export function standingObjections(d: Data, claim: Claim): Objection[] {
  return d.objection.filter((o) => o.claimId === claim.id && (STANDING.has(o.status) || (o.status === "conceded" && o.revision === claim.revision)));
}

export function agentName(d: Data, id: string): string {
  return d.agent.find((a) => a.id === id)?.name ?? id;
}

const REF = /\[\[([A-Z]\d+)\]\]/g;

export function knownIds(d: Data): Set<string> {
  const ids = new Set<string>();
  for (const k of ["claim", "source", "experiment", "leancheck", "artifact", "upload", "objection", "obligation", "review", "evidence"] as EntityKind[]) {
    for (const e of d[k] as { id: string }[]) ids.add(e.id);
  }
  return ids;
}

/** Reference tokens in a text that do not resolve to a ledger item. */
export function validateRefs(md: string, ids: Set<string>): string[] {
  const bad = new Set<string>();
  for (const m of md.matchAll(REF)) if (!ids.has(m[1])) bad.add(m[1]);
  return [...bad];
}

/** Problems that make a model-written narrative unacceptable: dangling tokens and bibliographic details not backed by a retrieved source. */
export function validateNarrative(md: string, d: Data): string[] {
  const problems: string[] = [];
  const bad = validateRefs(md, knownIds(d));
  if (bad.length) problems.push(`These reference tokens do not exist in the ledger: ${bad.map((b) => `[[${b}]]`).join(", ")}.`);
  const known = d.source.flatMap((s) => [s.url, s.doi, s.arxivId].filter((v): v is string => !!v).map((v) => v.toLowerCase()));
  const loose: string[] = [];
  for (const m of md.matchAll(/https?:\/\/[^\s)\]>"']+|\b10\.\d{4,9}\/[^\s)\]>"']+|arXiv:\s?\d{4}\.\d{4,5}/gi)) {
    const v = m[0].toLowerCase().replace(/[.,;]+$/, "").replace(/^arxiv:\s?/, "");
    if (!known.some((k) => k.includes(v) || v.includes(k))) loose.push(m[0]);
  }
  if (loose.length) {
    problems.push(`These links or identifiers were not returned by a retrieval tool in this run: ${[...new Set(loose)].slice(0, 6).join(", ")}. Cite sources by token ([[S..]]) and let the platform print the bibliographic details.`);
  }
  return problems;
}

/** Replaces reference tokens by readable labels for exported text. */
export function resolveTokens(md: string, d: Data): string {
  return md.replace(REF, (m, id: string) => {
    if (id[0] === "C") {
      const c = d.claim.find((x) => x.id === id);
      return c ? `**${id}** (${LABEL_NAMES[c.label]})` : m;
    }
    return `**${id}**`;
  });
}

function sourceLine(d: Data, id: string): string {
  const s = d.source.find((x) => x.id === id);
  if (!s) return id;
  const bits = [s.authors.length ? `${s.authors.slice(0, 6).join(", ")}${s.authors.length > 6 ? " et al." : ""}.` : "", `*${s.title}*.`, s.venue ? `${s.venue}.` : "", s.date ? `${s.date}.` : "", s.doi ? `doi:${s.doi}.` : "", s.arxivId ? `arXiv:${s.arxivId}.` : "", s.url ?? ""];
  return bits.filter(Boolean).join(" ");
}

function claimHead(d: Data, c: Claim): string {
  const flags = [c.status !== "active" ? c.status.toUpperCase() : "", c.stale ? "INVALIDATED" : "", c.answersGoal ? "answers the goal" : ""].filter(Boolean).join(", ");
  return `**${c.id}** · ${LABEL_NAMES[c.label]} · revision ${c.revision} · ${agentName(d, c.team)} team${flags ? ` · ${flags}` : ""}`;
}

export function goalSummary(d: Data): { reached: boolean; claim?: Claim; line: string } {
  const run = d.run[0];
  const claim = run?.goalClaimId ? d.claim.find((c) => c.id === run.goalClaimId) : undefined;
  if (run?.goalReached && claim) return { reached: true, claim, line: `Goal reached: ${claim.id} stands as "${LABEL_NAMES[claim.label]}".` };
  const best = d.claim
    .filter((c) => c.answersGoal && c.status === "active")
    .sort((a, b) => LABELS.indexOf(b.label) - LABELS.indexOf(a.label))[0];
  return {
    reached: false,
    claim: best,
    line: best
      ? `Goal not reached. The best current answer is ${best.id}, which stands as "${LABEL_NAMES[best.label]}"; the required standard is "${LABEL_NAMES[run?.config.standard ?? "reviewed"]}".`
      : "Goal not reached. No claim answering the goal has been recorded.",
  };
}

export function labelCounts(d: Data): Record<Label, number> {
  const out = { conjecture: 0, numerical: 0, partial: 0, candidate: 0, reviewed: 0, formal: 0 } as Record<Label, number>;
  for (const c of d.claim) if (c.status === "active") out[c.label]++;
  return out;
}

export function runFacts(run: RunState, now: number): string[] {
  const elapsed = run.activeMs + (run.status === "running" && run.lastTickAt ? Math.max(0, now - run.lastTickAt) : 0);
  return [
    `Status: ${run.status.replace("_", " ")}${run.outcome ? ` — ${run.outcome}` : ""}`,
    `Stage: cycle ${run.cycle}, ${PHASE_NAMES[run.phase]}`,
    run.config.limits.untilSpend ? `Active time: ${fmtDuration(elapsed)} (set to continue until the spending limit is reached)` : `Active time: ${fmtDuration(elapsed)} of ${run.config.limits.runtimeMin} min allowed`,
    `Spend: ${fmtUsd(run.spend.usd)} of ${fmtUsd(run.config.limits.spendUsd)} allowed, over ${run.spend.calls} model calls`,
    `Subagents: ${run.subagents.created} of ${run.config.limits.subagentCap} created (${run.subagents.completed} completed, ${run.subagents.running} running, ${run.subagents.queued} queued, ${run.subagents.failed} failed, ${run.subagents.cancelled} cancelled)`,
  ];
}

/** Currency in Markdown: an unescaped dollar sign would open inline math in the reader and in the LaTeX export. */
const mdMoney = (s: string): string => s.replace(/\$/g, "\\$");

/** Shifts the headings of an embedded text so that its top level becomes `top`; fenced code is left alone. */
export function demoteHeadings(md: string, top = 3): string {
  const lines = md.replace(/\r/g, "").split("\n");
  const heads: { i: number; level: number; text: string }[] = [];
  let open: string | null = null;
  lines.forEach((line, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!open) open = f[1];
      else if (f[1][0] === open[0] && f[1].length >= open.length) open = null;
      return;
    }
    if (open) return;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) heads.push({ i, level: h[1].length, text: h[2] });
  });
  if (!heads.length) return md;
  const shift = top - Math.min(...heads.map((h) => h.level));
  if (shift <= 0) return md;
  for (const h of heads) lines[h.i] = `${"#".repeat(Math.min(6, h.level + shift))} ${h.text}`;
  return lines.join("\n");
}

const fence = (s: string, lang = ""): string => {
  const ticks = s.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${s.replace(/\s+$/, "")}\n${ticks}`;
};

export interface ReportOptions {
  now?: number;
  /** Include full experiment code and output. */
  full?: boolean;
}

export function buildReport(d: Data, opts: ReportOptions = {}): string {
  const run = d.run[0];
  if (!run) return "# No run\n";
  const now = opts.now ?? Date.now();
  const full = opts.full ?? true;
  const out: string[] = [];
  const g = goalSummary(d);
  const claims = byNum(d.claim);
  const narrative = run.reportArtifactId ? d.artifact.find((a) => a.id === run.reportArtifactId) : undefined;

  out.push(`# ${run.config.title || "Untitled investigation"}`);
  out.push(`*Scholium research report · ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC · ${g.reached ? "final" : "checkpoint, not a final result"}*`);
  out.push(`> **Goal.** ${run.config.goal.trim()}`);
  if (run.config.acceptance.trim()) out.push(`> **Counts as done when.** ${run.config.acceptance.trim()}`);
  out.push(`> **Required standard.** ${LABEL_NAMES[run.config.standard]}. Labels are assigned by the platform from the evidence; agreement between models is not proof.`);

  out.push("## Status");
  out.push([g.line, ...runFacts(run, now).map(mdMoney)].map((l) => `- ${l}`).join("\n"));
  out.push(
    `- Lead models: ${d.agent
      .filter((a) => a.kind === "lead" && a.active)
      .map((a) => `${MODELS[a.model].label} (effort ${MODELS[a.model].effort})`)
      .join("; ")} · mode: ${run.config.mode}`,
  );

  out.push("## Answer");
  if (g.claim) {
    out.push(claimHead(d, g.claim));
    out.push(g.claim.statement);
    if (!g.reached && g.claim.blockers.length) out.push(`*Why it is not rated higher:* ${g.claim.blockers.join(" ")}`);
  } else out.push("No claim answering the goal has been recorded.");

  if (narrative) {
    out.push(`## Narrative`);
    out.push(`*Written by ${agentName(d, narrative.byAgent)}. Reference tokens were checked against the ledger.*`);
    out.push(demoteHeadings(resolveTokens(narrative.content, d)));
  }

  out.push("## Results by verification level");
  for (const label of [...LABELS].reverse()) {
    const list = claims.filter((c) => c.status === "active" && c.label === label);
    if (!list.length) continue;
    out.push(`### ${LABEL_NAMES[label]} (${list.length})`);
    for (const c of list) {
      out.push(claimHead(d, c));
      out.push(c.statement);
      if (c.dependsOn.length) out.push(`Depends on: ${c.dependsOn.join(", ")}.`);
      if (c.blockers.length) out.push(`*Why it is not rated higher:* ${c.blockers.join(" ")}`);
    }
  }
  const dead = claims.filter((c) => c.status !== "active");
  if (dead.length) {
    out.push(`### Refuted or withdrawn (${dead.length})`);
    for (const c of dead) out.push(`- **${c.id}** (${c.status}${c.statusReason ? `: ${oneLine(c.statusReason, 240)}` : ""}) ${oneLine(c.statement, 300)}`);
  }

  const argued = claims.filter((c) => c.status === "active" && c.argument.trim().length >= 40);
  if (argued.length) {
    out.push("## Arguments");
    for (const c of argued) {
      out.push(`### ${c.id} — ${LABEL_NAMES[c.label]}`);
      out.push(`**Statement.** ${c.statement}`);
      out.push(`**Argument.** ${c.argument.trim()}`);
    }
  }

  out.push("## Evidence linked to claims");
  const ev = byNum(d.evidence);
  if (!ev.length) out.push("No evidence has been attached to any claim.");
  for (const c of claims) {
    const mine = ev.filter((e) => e.claimId === c.id);
    if (!mine.length) continue;
    out.push(`**${c.id}**`);
    out.push(
      mine
        .map((e) => {
          const current = e.revision === c.revision ? "" : ` (for revision ${e.revision}, no longer counted)`;
          if (e.kind === "citation") return `- ${e.id} ${e.stance} · source ${e.sourceId} · quote ${e.quoteStatus?.replace("_", " ")}${current}: “${oneLine(e.quote ?? "", 400)}”${e.locator ? ` (${e.locator})` : ""}`;
          if (e.kind === "experiment") return `- ${e.id} ${e.stance} · experiment ${e.experimentId}${current}: ${oneLine(e.summary, 300)}`;
          return `- ${e.id} ${e.stance} · ${e.kind}${current}: ${oneLine(e.summary, 300)}`;
        })
        .join("\n"),
    );
  }

  out.push("## Experiments");
  const exps = byNum(d.experiment);
  if (!exps.length) out.push("No code was executed in this run.");
  for (const e of exps) {
    const ok = e.status === "ok" && e.verified.command && e.verified.transcript;
    out.push(`### ${e.id} — ${oneLine(e.purpose, 200)}`);
    out.push(`- Result: ${e.status}${e.exit !== undefined ? ` (exit ${e.exit})` : ""} · ${ok ? "integrity checks passed (the sandbox ran exactly this code and the output checksum matched)" : "NOT usable as evidence"} · ${e.runtime} · run by ${agentName(d, e.byAgent)}${e.seed !== undefined ? ` · seed ${e.seed}` : ""}`);
    if (e.claimIds.length) out.push(`- Linked to: ${e.claimIds.join(", ")}`);
    if (e.error) out.push(`- Error: ${e.error}`);
    if (full) {
      out.push(fence(e.code, e.lang === "bash" ? "bash" : "python"));
      if (e.stdout) out.push(`Output${e.stdoutChars > e.stdout.length ? ` (${e.stdoutChars} characters in total, shortened)` : ""}:\n${fence(e.stdout)}`);
      if (e.stderr) out.push(`Error stream:\n${fence(e.stderr)}`);
    }
  }

  out.push("## Sources");
  const cited = new Set(d.evidence.map((e) => e.sourceId).filter(Boolean));
  const srcs = byNum(d.source);
  const used = srcs.filter((s) => cited.has(s.id));
  out.push(`${srcs.length} source${srcs.length === 1 ? "" : "s"} were retrieved; ${used.length} are cited as evidence. Bibliographic details are printed exactly as the retrieval service returned them.`);
  for (const s of used.length ? used : srcs.slice(0, 40)) {
    const cites = d.evidence.filter((e) => e.sourceId === s.id).map((e) => `${e.claimId} (${e.quoteStatus?.replace("_", " ")})`);
    out.push(`- **${s.id}** ${sourceLine(d, s.id)} — via ${s.via}${cites.length ? ` — cited for ${[...new Set(cites)].join(", ")}` : ""}`);
  }
  if (used.length && srcs.length > used.length) out.push(`Retrieved but not cited: ${srcs.filter((s) => !cited.has(s.id)).map((s) => s.id).join(", ")}.`);

  out.push("## Verification record");
  const reviews = byNum(d.review);
  out.push(`### Reviews (${reviews.length})`);
  for (const r of reviews) {
    const c = d.claim.find((x) => x.id === r.claimId);
    out.push(
      `- ${r.id}: ${agentName(d, r.byAgent)} — **${r.verdict.replace("_", " ")}** on ${r.claimId} revision ${r.revision}${c && c.revision !== r.revision ? " (superseded by a later revision)" : ""}. ${oneLine(r.summary, 400)}${
        r.citationsAudited.length ? ` Citations audited: ${r.citationsAudited.join(", ")}.` : ""
      }${r.recomputed.length ? ` Recomputed in: ${r.recomputed.join(", ")}.` : ""}`,
    );
  }
  const objs = byNum(d.objection);
  out.push(`### Objections (${objs.length})`);
  for (const o of objs) {
    out.push(`- ${o.id} (${o.severity}, **${o.status}**) by ${agentName(d, o.byAgent)} on ${o.claimId} revision ${o.revision}: ${oneLine(o.text, 600)}`);
    for (const r of o.responses) out.push(`  - ${r.kind} by ${agentName(d, r.by)}: ${oneLine(r.text, 500)}`);
  }
  const obls = byNum(d.obligation);
  out.push(`### Proof obligations (${obls.length})`);
  for (const o of obls) out.push(`- ${o.id} (${o.status}) on ${o.claimId}: ${oneLine(o.text, 400)}${o.resolution ? ` — discharged: ${oneLine(o.resolution, 300)}` : ""}`);
  const leans = byNum(d.leancheck);
  out.push(`### Formal checks (${leans.length})`);
  if (!leans.length) out.push("No formal check was run.");
  for (const l of leans) {
    out.push(
      `- ${l.id} on ${l.claimId} revision ${l.revision}: ${l.ok ? "accepted by Lean" : "rejected"}${l.hasSorry ? ", contains sorry" : ""}${l.declaresAxioms ? ", declares axioms" : ""} · axioms used: ${l.axioms.join(", ") || "none"} · ${l.versions || "version not reported"} · faithfulness: ${
        l.faithfulness ? `${l.faithfulness.faithful ? "confirmed" : "denied"} by ${agentName(d, l.faithfulness.byAgent)}` : "not yet reviewed"
      }`,
    );
    if (full) out.push(fence(l.source, "lean"));
  }

  out.push("## Gaps and disagreements");
  const gaps: string[] = [];
  for (const o of objs.filter((x) => STANDING.has(x.status))) gaps.push(`Objection ${o.id} on ${o.claimId} is ${o.status}: ${oneLine(o.text, 300)}`);
  for (const o of obls.filter((x) => x.status === "open")) gaps.push(`Obligation ${o.id} on ${o.claimId} is open: ${oneLine(o.text, 300)}`);
  for (const c of claims.filter((x) => x.stale)) gaps.push(`${c.id} is invalidated: ${c.staleReason ?? "a dependency failed"}.`);
  for (const c of claims.filter((x) => x.status === "active" && x.basis === "memory" && x.label === "conjecture")) gaps.push(`${c.id} rests on model memory only and is unverified.`);
  for (const e of ev.filter((x) => x.kind === "citation" && (x.quoteStatus === "not_found" || x.quoteStatus === "unverifiable"))) gaps.push(`Citation ${e.id} for ${e.claimId} is ${e.quoteStatus?.replace("_", " ")} in source ${e.sourceId}.`);
  for (const a of d.agent.filter((x) => x.kind === "subagent" && x.status === "completed" && !x.review)) gaps.push(`Output of ${a.name} was not reviewed${a.reviewNote ? `: ${a.reviewNote}` : "."}`);
  out.push(gaps.length ? gaps.map((l) => `- ${l}`).join("\n") : "None recorded.");

  const decisions = d.note.filter((n) => n.kind === "decision").sort((a, b) => b.createdAt - a.createdAt);
  out.push("## Next steps");
  if (decisions.length) {
    const cycle = decisions[0].cycle;
    for (const n of decisions.filter((x) => x.cycle === cycle)) out.push(`**${agentName(d, n.byAgent)}** (cycle ${n.cycle}): ${n.text}`);
  } else out.push("No decision has been recorded yet.");

  out.push("## Run record");
  const calls = d.call;
  const perModel = new Map<string, { n: number; usd: number; reported: Set<string> }>();
  for (const c of calls) {
    const m = perModel.get(c.gatewayModel) ?? { n: 0, usd: 0, reported: new Set<string>() };
    m.n++;
    m.usd += c.costUsd;
    if (c.providerModel) m.reported.add(c.providerModel);
    perModel.set(c.gatewayModel, m);
  }
  if (perModel.size) {
    for (const [id, m] of perModel) out.push(`- ${id}: ${m.n} calls, ${mdMoney(fmtUsd(m.usd))}; provider reported: ${[...m.reported].join(", ") || "not reported"}`);
  }
  const cps = byNum(d.checkpoint);
  if (cps.length) out.push(`- Checkpoints: ${cps.map((c) => `${c.id} (cycle ${c.cycle}, ${PHASE_NAMES[c.phase]}; ${c.reason})`).join("; ")}`);
  out.push(`- Run id: ${run.id}${run.branchedFrom ? ` · branched from ${run.branchedFrom.runId} at ${run.branchedFrom.checkpointId}` : ""}`);
  return `${out.join("\n\n")}\n`;
}

// ---------- LaTeX ----------
const TEX_ESC: Record<string, string> = { "&": "\\&", "%": "\\%", "#": "\\#", _: "\\_", "{": "\\{", "}": "\\}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}", "\\": "\\textbackslash{}" };
const texEscape = (s: string): string => s.replace(/[&%#_{}~^\\]/g, (c) => TEX_ESC[c]);

function texInline(s: string): string {
  // Split out math and code so that their contents are left alone.
  const parts: string[] = [];
  const keep = (v: string): string => {
    parts.push(v);
    return `\u0000${parts.length - 1}\u0000`;
  };
  let t = s
    .replace(/\\\$/g, () => keep("\\$"))
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, x: string) => keep(`\\[${x}\\]`))
    .replace(/\$([^$\n]+?)\$/g, (_m, x: string) => keep(`$${x}$`))
    .replace(/`([^`\n]+)`/g, (_m, x: string) => keep(`\\texttt{${texEscape(x)}}`))
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, a: string, u: string) => keep(`\\href{${u.replace(/[%#]/g, "\\$&")}}{${texEscape(a)}}`))
    .replace(/https?:\/\/[^\s)]+/g, (u) => keep(`\\url{${u}}`));
  t = texEscape(t)
    .replace(/\*\*([^*]+)\*\*/g, "\\textbf{$1}")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1\\emph{$2}");
  // eslint-disable-next-line no-control-regex
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => parts[Number(i)]);
}

export function toLatex(md: string, title = "Scholium report"): string {
  // The same reading of formulas as on screen: \( … \), \[ … \], one-line $$ … $$ and bare environments all work.
  const lines = normalizeMath(md.replace(/\r/g, "")).split("\n");
  const body: string[] = [];
  let list: "itemize" | "enumerate" | null = null;
  let quote = false;
  const close = () => {
    if (list) body.push(`\\end{${list}}`);
    list = null;
    if (quote) body.push("\\end{quote}");
    quote = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceOpen = /^(`{3,})(.*)$/.exec(line);
    if (fenceOpen) {
      close();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fenceOpen[1])) code.push(lines[i++]);
      body.push("\\begin{verbatim}", ...code.map((c) => c.replace(/\\end\{verbatim\}/g, "\\end {verbatim}")), "\\end{verbatim}");
      continue;
    }
    if (/^\$\$/.test(line.trim())) {
      close();
      const math: string[] = [line.trim().replace(/^\$\$/, "")];
      while (!/\$\$\s*$/.test(math[math.length - 1]) && i + 1 < lines.length) math.push(lines[++i]);
      const tex = math.join("\n").replace(/\$\$\s*$/, "").trim();
      // align, gather and equation are displays by themselves; LaTeX rejects them inside \[ … \].
      body.push(/^\\begin\{(align|alignat|gather|multline|equation)\*?\}/.test(tex) ? tex : `\\[${tex}\\]`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      close();
      if (h[1].length === 1) continue; // the document title
      const cmd = ["section", "subsection", "subsubsection", "paragraph"][Math.min(3, h[1].length - 2)];
      body.push(`\\${cmd}{${texInline(h[2])}}`);
      continue;
    }
    if (/^\|/.test(line)) {
      close();
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      i--;
      body.push("\\begin{verbatim}", ...rows, "\\end{verbatim}");
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      if (list) close();
      if (!quote) {
        body.push("\\begin{quote}");
        quote = true;
      }
      body.push(texInline(q[1]), "");
      continue;
    }
    const li = /^\s*(-|\*|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const kind = /\d/.test(li[1]) ? "enumerate" : "itemize";
      if (quote || (list && list !== kind)) close();
      if (!list) {
        body.push(`\\begin{${kind}}`);
        list = kind;
      }
      body.push(`\\item ${texInline(li[2])}`);
      continue;
    }
    if (!line.trim()) {
      close();
      body.push("");
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      body.push(texInline(line.trim()));
      continue;
    }
    close();
    body.push(texInline(line));
  }
  close();
  return `% Generated by Scholium. Compile with lualatex or xelatex (the text contains Unicode).
\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{hyperref}
\\usepackage{iftex}
\\ifPDFTeX\\usepackage[utf8]{inputenc}\\usepackage[T1]{fontenc}\\else\\usepackage{fontspec}\\fi
\\setlength{\\parindent}{0pt}\\setlength{\\parskip}{0.6em}
\\title{${texInline(title)}}
\\date{}
\\begin{document}
\\maketitle
${body.join("\n").replace(/\n{3,}/g, "\n\n")}
\\end{document}
`;
}

// ---------- Email ----------
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildDigest(d: Data, kind: "digest" | "goal" | "attention" | "test", now: number): { subject: string; text: string; html: string } {
  const run = d.run[0];
  const title = run?.config.title || "Untitled investigation";
  const g = goalSummary(d);
  const counts = labelCounts(d);
  const link = run?.origin ? `${run.origin}/r/${run.id}` : "";
  const subject =
    kind === "goal"
      ? `Scholium: goal reached — ${title}`
      : kind === "attention"
        ? `Scholium needs you — ${title}`
        : kind === "test"
          ? "Scholium: test message"
          : `Scholium update — ${title}`;
  const lines: string[] = [];
  if (kind === "test") lines.push("This is a test message from Scholium. Email alerts are working.");
  if (run) {
    if (kind === "attention") lines.push(`The run stopped and is waiting for you: ${run.outcome || run.pauseReason || run.error || "see the workspace"}.`);
    lines.push(g.line, ...runFacts(run, now));
    lines.push(`Claims by label: ${LABELS.map((l) => `${LABEL_NAMES[l]} ${counts[l]}`).join(" · ")}`);
    const open = d.objection.filter((o) => STANDING.has(o.status)).length;
    const obl = d.obligation.filter((o) => o.status === "open").length;
    lines.push(`Standing objections: ${open} · open proof obligations: ${obl} · experiments run: ${d.experiment.length} · sources retrieved: ${d.source.length}`);
    if (g.claim) lines.push(`${g.claim.id} (${LABEL_NAMES[g.claim.label]}): ${oneLine(g.claim.statement, 500)}`);
    const since = run.lastDigestAt ?? run.startedAt ?? 0;
    const fresh = d.claim.filter((c) => c.updatedAt > since && c.status === "active").slice(-6);
    if (kind === "digest" && fresh.length) {
      lines.push("New or changed since the last update:");
      for (const c of fresh) lines.push(`  ${c.id} (${LABEL_NAMES[c.label]}): ${oneLine(c.statement, 220)}`);
    }
    if (link) lines.push(`Open the run: ${link}`);
  }
  lines.push("Labels are assigned by the platform from recorded evidence. Agreement between models is not proof.");
  const html = `<div style="font-family:Georgia,serif;font-size:15px;line-height:1.55;color:#1f1b16;max-width:640px">
<p style="font:600 12px/1.2 Helvetica,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#b3401f;margin:0 0 6px">Scholium</p>
<h2 style="font-size:20px;margin:0 0 14px">${esc(subject.replace(/^Scholium[^—]*— /, ""))}</h2>
${lines.map((l) => (l.startsWith("Open the run: ") ? `<p><a href="${esc(link)}" style="color:#b3401f">Open the run</a></p>` : `<p style="margin:0 0 8px">${esc(l)}</p>`)).join("\n")}
</div>`;
  return { subject, text: lines.join("\n"), html };
}
