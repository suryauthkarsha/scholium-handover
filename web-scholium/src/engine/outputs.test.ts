/**
 * Outputs and controls: citation checking, the report and its exports, formal checks, the instruction queue,
 * uploads, checkpoints and branches, email alerts and Google Drive.
 */
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "./engine";
import { demoteHeadings, toLatex } from "./report";
import { atPhase, cooperative, makeHarness, useTool, type Harness } from "./testkit";
import type { LeanOutcome } from "./services";

const A = "lead-astra62";
const F = "lead-fable52";

const PAPER_URL = "https://example.org/papers/goldbach-small";
const PAPER_TEXT =
  "We verify the binary Goldbach conjecture for small even integers. Theorem 1. Every even integer n with 4 <= n <= 4000 can be written as the sum of two prime numbers. " +
  "The proof is a direct enumeration carried out by computer and checked by hand for all n below one hundred. We make no claim beyond this range.";
const EXACT = "Every even integer n with 4 <= n <= 4000 can be written as the sum of two prime numbers.";
const NEAR = "Every even integer n with 4 <= n <= 4000 can be written as a sum of two prime numbers.";
const INVENTED = "Every even integer greater than two is the sum of two primes, as proved unconditionally in Section 3.";
const ARGUMENT = "For each even n with 4 <= n <= 40 an explicit pair of primes summing to n is listed, and each listed number is checked to be prime by trial division; the finite list of cases is therefore exhausted.";

async function fetchPaper(h: Harness, by = A): Promise<string> {
  h.svc.docs.set(PAPER_URL, { title: "Small cases of the Goldbach conjecture", text: PAPER_TEXT, via: "direct fetch (test)", complete: true });
  const r = await useTool(h, by, "fetch_document", { url: PAPER_URL });
  expect(r.ok, r.text).toBe(true);
  const src = h.eng.all("source").find((s) => s.url === PAPER_URL);
  expect(src).toBeDefined();
  return src!.id;
}

async function claim(h: Harness, by: string, args: Record<string, unknown> = {}): Promise<string> {
  const before = new Set(h.eng.all("claim").map((c) => c.id));
  const r = await useTool(h, by, "record_claim", { statement: "Every even integer n with 4 <= n <= 40 is a sum of two primes.", proposed_label: "candidate", basis: "derived", argument: ARGUMENT, ...args });
  expect(r.ok, r.text).toBe(true);
  return h.eng.all("claim").find((c) => !before.has(c.id))!.id;
}

const label = (h: Harness, id: string) => h.eng.m.claim.get(id)!.label;
const blockers = (h: Harness, id: string) => h.eng.m.claim.get(id)!.blockers.join(" ");
const events = (h: Harness, type: string) => {
  h.eng.flush();
  return h.store.events.filter((e) => e.type === type);
};

describe("citations are checked against retrieved text", () => {
  it("a result attributed to the literature stays a conjecture until a quote is found in the retrieved source", async () => {
    const h = atPhase(makeHarness(), "work");
    const sid = await fetchPaper(h);
    expect(sid).toBe("S1");
    expect(h.eng.sourceText(sid)).toContain("Theorem 1.");

    const c = await claim(h, A, { statement: "Every even n with 4 <= n <= 4000 is a sum of two primes (known).", proposed_label: "partial", basis: "retrieved", argument: undefined });
    expect(label(h, c)).toBe("conjecture");
    expect(blockers(h, c)).toMatch(/Marked as coming from the literature, but no retrieved source with a machine-checked quote is attached/);

    const r = await useTool(h, A, "add_evidence", { claim_id: c, kind: "citation", summary: "Theorem 1 of the source states the range.", source_id: sid, quote: EXACT });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/found verbatim in S1/);
    const ev = h.eng.all("evidence")[0];
    expect(ev).toMatchObject({ kind: "citation", sourceId: "S1", quoteStatus: "verified", claimId: c });
    expect(label(h, c)).toBe("partial");
    expect(blockers(h, c)).not.toMatch(/literature/);
  });

  it("a close paraphrase is recorded as approximate, never as verbatim", async () => {
    const h = atPhase(makeHarness(), "work");
    const sid = await fetchPaper(h);
    const c = await claim(h, A, { proposed_label: "partial", basis: "retrieved", argument: undefined });
    const r = await useTool(h, A, "add_evidence", { claim_id: c, kind: "citation", summary: "Theorem 1.", source_id: sid, quote: NEAR });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/only approximately/);
    expect(h.eng.all("evidence")[0].quoteStatus).toBe("approximate");
  });

  it("an invented quote is flagged, holds the claim back, and can only be replaced by a quote that is really there", async () => {
    const h = atPhase(makeHarness(), "cross_review");
    const sid = await fetchPaper(h);
    const c = await claim(h, A, { proposed_label: "partial", basis: "retrieved", argument: undefined });
    const bad = await useTool(h, A, "add_evidence", { claim_id: c, kind: "citation", summary: "The source proves the full conjecture.", source_id: sid, quote: INVENTED });
    expect(bad.ok, bad.text).toBe(true);
    expect(bad.text).toMatch(/THE QUOTE WAS NOT FOUND/);
    const v1 = h.eng.all("evidence")[0];
    expect(v1.quoteStatus).toBe("not_found");
    expect(label(h, c)).toBe("conjecture");
    expect(blockers(h, c)).toContain(`Quote not found in the cited source: ${v1.id}.`);
    const warn = events(h, "citation");
    expect(warn).toHaveLength(1);
    expect(warn[0].level).toBe("warn");
    expect(warn[0].text).toMatch(/the quote is not in the retrieved text/);

    // The other team cannot quietly replace it, and a verified citation cannot be replaced at all.
    const other = await useTool(h, F, "add_evidence", { claim_id: c, kind: "citation", summary: "Theorem 1.", source_id: sid, quote: EXACT, replaces: v1.id });
    expect(other.ok).toBe(false);
    expect(other.text).toMatch(/cannot be replaced/);

    const good = await useTool(h, A, "add_evidence", { claim_id: c, kind: "citation", summary: "Theorem 1 states the range.", source_id: sid, quote: EXACT, replaces: v1.id });
    expect(good.ok, good.text).toBe(true);
    expect(h.eng.m.evidence.has(v1.id)).toBe(false);
    const left = h.eng.all("evidence");
    expect(left).toHaveLength(1);
    expect(left[0].quoteStatus).toBe("verified");
    expect(label(h, c)).toBe("partial");
    expect(blockers(h, c)).not.toMatch(/Quote not found/);

    const again = await useTool(h, A, "add_evidence", { claim_id: c, kind: "citation", summary: "The method.", source_id: sid, quote: "The proof is a direct enumeration carried out by computer", replaces: left[0].id });
    expect(again.ok).toBe(false);
    expect(again.text).toMatch(/cannot be replaced/);
  });

  it("refuses sources that were never retrieved and quotes too short to check; a source without text cannot support anything", async () => {
    const h = atPhase(makeHarness(), "work");
    const c = await claim(h, A, { proposed_label: "partial", basis: "retrieved", argument: undefined });

    const ghost = await useTool(h, A, "add_evidence", { claim_id: c, kind: "citation", summary: "From memory.", source_id: "S99", quote: EXACT });
    expect(ghost.ok).toBe(false);
    expect(ghost.text).toMatch(/There is no source S99\. Sources are created only by the retrieval tools and by user uploads/);

    h.svc.papers = [{ title: "On sums of two primes", authors: ["A. Author"], date: "2019", doi: "10.1234/goldbach.2019", abstract: "", via: "crossref (test)" }];
    const found = await useTool(h, A, "literature_search", { query: "Goldbach small cases verification" });
    expect(found.ok, found.text).toBe(true);
    const src = h.eng.all("source")[0];
    expect(src.doi).toBe("10.1234/goldbach.2019");
    expect(src.textChars).toBe(0);

    const short = await useTool(h, A, "add_evidence", { claim_id: c, kind: "citation", summary: "Too short.", source_id: src.id, quote: "two primes" });
    expect(short.ok).toBe(false);

    const blind = await useTool(h, A, "add_evidence", { claim_id: c, kind: "citation", summary: "The paper is said to prove it.", source_id: src.id, quote: EXACT });
    expect(blind.ok, blind.text).toBe(true);
    expect(blind.text).toMatch(/could not be checked and does not count as support/);
    expect(h.eng.all("evidence")[0].quoteStatus).toBe("unverifiable");
    expect(label(h, c)).toBe("conjecture");
    expect(blockers(h, c)).toMatch(/could not be checked because the source text was not retrievable/);

    // A document that cannot be fetched produces no source at all.
    const missing = await useTool(h, A, "fetch_document", { url: "https://example.org/does-not-exist" });
    expect(missing.ok).toBe(false);
    expect(missing.text).toMatch(/404/);
    expect(h.eng.all("source")).toHaveLength(1);
  });
});

describe("the report", () => {
  const NARRATIVE = (extra = "") =>
    `## Answer\n\nThe question is settled for the stated range by [[C1]]. Each even integer in the range was decomposed explicitly and every listed number was checked to be prime by trial division.\n\n## How it was established\n\nThe cases were enumerated with code that is kept with the run, and the written argument was read line by line. No step relies on a result that was not produced or retrieved in this run, and what remains open is listed by the platform below. ${extra}`;

  it("a narrative is refused when it is a stub, skips the goal claim, cites tokens that do not exist or carries links no retrieval tool returned", async () => {
    const h = atPhase(makeHarness(), "work");
    const c = await claim(h, A, { answers_goal: true });
    expect(c).toBe("C1");
    h.eng.run.goalClaimId = c;
    h.eng.touch();

    const stub = await useTool(h, A, "submit_report", { markdown: "Done, see [[C1]]." }, "report");
    expect(stub.ok).toBe(false);
    expect(stub.text).toMatch(/too short/);

    const noGoal = await useTool(h, A, "submit_report", { markdown: NARRATIVE().replace("[[C1]]", "the main claim") }, "report");
    expect(noGoal.ok).toBe(false);
    expect(noGoal.text).toMatch(/must refer to the claim that answers the goal by its token \[\[C1\]\]/);

    const ghost = await useTool(h, A, "submit_report", { markdown: NARRATIVE("It also follows from [[C99]] and [[S7]].") }, "report");
    expect(ghost.ok).toBe(false);
    expect(ghost.text).toMatch(/These reference tokens do not exist in the ledger: \[\[C99\]\], \[\[S7\]\]\./);

    for (const loose of ["See https://arxiv.org/abs/1234.56789 for the general case.", "This is doi 10.1000/made.up.2020.", "Compare arXiv:2401.01234."]) {
      const r = await useTool(h, A, "submit_report", { markdown: NARRATIVE(loose) }, "report");
      expect(r.ok, loose).toBe(false);
      expect(r.text).toMatch(/These links or identifiers were not returned by a retrieval tool in this run/);
    }
    expect(h.eng.run.reportArtifactId).toBeUndefined();
    expect(h.eng.all("artifact")).toHaveLength(0);

    // A link that a retrieval tool did return is allowed, and so is a token for the source.
    const sid = await fetchPaper(h);
    const ok = await useTool(h, A, "submit_report", { markdown: NARRATIVE(`The range is also covered by [[${sid}]] (${PAPER_URL}).`) }, "report");
    expect(ok.ok, ok.text).toBe(true);
    expect(ok.text).toBe("Report accepted as A1.");
    expect(h.eng.run.reportArtifactId).toBe("A1");
    expect(h.eng.m.artifact.get("A1")).toMatchObject({ kind: "report", byAgent: A, version: 1, claimIds: ["C1"] });

    const second = await useTool(h, A, "submit_report", { markdown: NARRATIVE("Second version.") }, "report");
    expect(second.text).toBe("Report accepted as A1.");
    expect(h.eng.m.artifact.get("A1")!.version).toBe(2);
    expect(h.eng.all("artifact")).toHaveLength(1);
  });

  it("the submit_report tool exists only in the report task", async () => {
    const h = atPhase(makeHarness(), "work");
    const r = await useTool(h, A, "submit_report", { markdown: NARRATIVE() });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not offered/);
  });

  it("exports the whole record as Markdown, LaTeX and JSON", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h, { delegate: 1 });
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("completed");

    const md = h.eng.export("md");
    expect(md.filename).toBe("test-run.md");
    expect(md.mime).toMatch(/^text\/markdown/);
    const t = md.content;
    for (const head of [
      "# Test run",
      "## Status",
      "## Answer",
      "## Narrative",
      "## Results by verification level",
      "## Arguments",
      "## Evidence linked to claims",
      "## Experiments",
      "## Sources",
      "## Verification record",
      "### Reviews (2)",
      "### Objections (0)",
      "### Proof obligations (0)",
      "### Formal checks (0)",
      "## Gaps and disagreements",
      "## Next steps",
      "## Run record",
    ]) {
      expect(t, head).toContain(`\n${head === "# Test run" ? "" : "\n"}${head}\n`.replace(/^\n(?=# Test run)/, ""));
    }
    expect(t.startsWith("# Test run\n")).toBe(true);
    // The goal, the standard and the answer with its label.
    expect(t).toContain("> **Goal.** Decide whether every even integer greater than 2 and at most 40 is a sum of two primes.");
    expect(t).toContain("> **Required standard.** Model-reviewed argument.");
    expect(t).toContain("- Goal reached: C1 stands as \"Model-reviewed argument\".");
    expect(t).toMatch(/\*\*C1\*\* · Model-reviewed argument · revision 1/);
    // Experiments carry their code and their output.
    expect(t).toMatch(/### E1 — .*\n\n- Result: ok \(exit 0\) · integrity checks passed/);
    expect(t).toContain('```python\nprint("pairs for sub-1 turn 1")\n```');
    expect(t).toContain("Output:\n```\nok\n```");
    // Evidence is tied to claims, reviews to reviewers.
    expect(t).toMatch(/\*\*C1\*\*\n\n- V1 supports · experiment E\d+/);
    expect(t).toMatch(/- R2: Fable 5\.2 — \*\*accept\*\* on C1 revision 1\./);
    // Exactly which models ran, as requested and as the provider reported them.
    expect(t).toMatch(/- openai\/gpt-6\.2-astra-fast: \d+ calls, \\\$\d+\.\d+; provider reported: gpt-6\.2-astra-2026-10-01/);
    expect(t).toMatch(/- anthropic\/claude-fable-5\.2-fast: \d+ calls, \\\$\d+\.\d+; provider reported: claude-fable-5\.2-2026-10-01/);
    expect(t).toMatch(/- Checkpoints: K1 \(cycle 1, Done; completed\)/);
    expect(t).toMatch(/- Subagents: 2 of 100 created/);
    // Money never opens inline math: every dollar sign in the platform's own lines is escaped.
    expect(t).toMatch(/- Spend: \\\$\d+\.\d+ of \\\$40\.00 allowed, over \d+ model calls/);
    expect(t).not.toMatch(/(^|[^\\])\$\d/);
    // The lead's narrative is embedded below the platform's own headings, never beside them.
    expect(t.match(/^## Answer$/gm)).toHaveLength(1);
    expect(t).toContain("\n### Answer\n");
    expect(t).toContain("\n### How it was established\n");
    expect(t).toContain("*Written by Astra 6.2. Reference tokens were checked against the ledger.*");
    expect(t).not.toContain("[[");

    const tex = h.eng.export("tex");
    expect(tex.filename).toBe("test-run.tex");
    expect(tex.content).toContain("\\documentclass[11pt]{article}");
    expect(tex.content).toContain("\\title{Test run}");
    expect(tex.content).toContain("\\section{Status}");
    expect(tex.content).toContain("\\subsection{Answer}");
    expect(tex.content).toContain("\\begin{verbatim}\nprint(\"pairs for sub-1 turn 1\")\n\\end{verbatim}");
    expect(tex.content).toMatch(/\\item Spend: \\\$\d+\.\d+ of \\\$40\.00 allowed/);
    expect(tex.content).not.toContain("[[");
    expect(tex.content.trimEnd().endsWith("\\end{document}")).toBe(true);

    const json = h.eng.export("json");
    expect(json.filename).toBe("test-run.json");
    expect(json.mime).toMatch(/^application\/json/);
    const j = JSON.parse(json.content) as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(["exportedAt", "run", "agent", "task", "claim", "evidence", "obligation", "objection", "review", "source", "experiment", "leancheck", "artifact", "upload", "instruction", "checkpoint", "note", "email", "drivefile", "calls"]);
    const calls = j.calls as { model: string; gatewayModel?: string; requested: { effort: string }; purpose: string }[];
    expect(calls).toHaveLength(h.eng.run.spend.calls);
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(["astra62", "fable52"]));
    expect(calls.every((c) => c.requested.effort === "max")).toBe(true);
    // The owner's key hash never leaves the server.
    expect(json.content).not.toContain("owner-hash");
    expect(JSON.stringify(h.eng.publicSnapshot())).not.toContain("owner-hash");
  });

  it("a report written before the goal is reached says so and gives the reason", async () => {
    const h = atPhase(makeHarness(), "work");
    const c = await claim(h, A, { answers_goal: true });
    const t = h.eng.export("md").content;
    expect(t).toContain("checkpoint, not a final result");
    expect(t).not.toContain("- Goal reached");
    expect(t).toContain(`**${c}** · Candidate proof`);
    expect(t).toMatch(/\*Why it is not rated higher:\*/);
    expect(t).toContain("No formal check was run.");
  });

  it("LaTeX conversion keeps mathematics, escapes text and treats an escaped dollar as money", () => {
    const tex = toLatex("# T\n\nCost \\$5 of \\$40, with $x^2 + y_1$ & 50% of #1 in `a_b`.\n\n$$\n\\sum_{i=1}^n i\n$$\n\n- one\n- two\n\n```\n$raw & 100%\n```\n", "A & B");
    expect(tex).toContain("\\title{A \\& B}");
    expect(tex).toContain("Cost \\$5 of \\$40, with $x^2 + y_1$ \\& 50\\% of \\#1 in \\texttt{a\\_b}.");
    expect(tex).toMatch(/\\\[\s*\\sum_\{i=1\}\^n i\s*\\\]/);
    expect(tex).toContain("\\begin{itemize}\n\\item one\n\\item two\n\\end{itemize}");
    expect(tex).toContain("\\begin{verbatim}\n$raw & 100%\n\\end{verbatim}");
  });

  it("embedded headings are shifted below the host section and fenced code is left alone", () => {
    const out = demoteHeadings("# Title\n\ntext\n\n## Part\n\n```md\n# not a heading\n```\n\n### Deep\n");
    expect(out).toBe("### Title\n\ntext\n\n#### Part\n\n```md\n# not a heading\n```\n\n##### Deep\n");
    expect(demoteHeadings("### Already low\n\ntext")).toBe("### Already low\n\ntext");
    expect(demoteHeadings("no headings at all")).toBe("no headings at all");
  });
});

describe("formal verification", () => {
  const LEAN_OK: LeanOutcome = { ok: true, errors: [], warnings: [], infos: [], versions: "Lean (version 4.24.0)", log: "checked", axioms: ["propext"] };
  const SOURCE = "theorem goldbach_small : ∀ n : Nat, 4 ≤ n → n ≤ 40 → n % 2 = 0 → ∃ p q : Nat, Nat.Prime p ∧ Nat.Prime q ∧ p + q = n := by\n  decide\n";

  function lean(outcome: Partial<LeanOutcome> = {}): Harness {
    const h = atPhase(makeHarness({ config: { tools: { lean: true } } }), "cross_review");
    h.svc.health.lean = { ok: true, detail: "ok" };
    h.svc.leanOutcome = { ...LEAN_OK, ...outcome };
    return h;
  }

  it("the Lean tools are not offered unless a checker is configured and reachable", async () => {
    const off = atPhase(makeHarness(), "work");
    const c = await claim(off, A);
    const r = await useTool(off, A, "lean_check", { claim_id: c, theorem_name: "goldbach_small", source: SOURCE });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not offered/);

    // Switched on in the settings, but the preflight found the server unreachable: still not offered.
    const down = atPhase(makeHarness({ config: { tools: { lean: true } } }), "work");
    down.svc.health.lean = { ok: false, detail: "HTTP 403 from the Lean server" };
    await down.eng.preflight();
    expect(down.eng.toolOk("lean")).toBe(false);
    const c2 = await claim(down, A);
    const r2 = await useTool(down, A, "lean_check", { claim_id: c2, theorem_name: "goldbach_small", source: SOURCE });
    expect(r2.ok).toBe(false);
    expect(r2.text).toMatch(/not offered/);
  });

  it("the formal badge needs a clean check and a faithfulness review by a different model", async () => {
    const h = lean();
    const c = await claim(h, A);
    const r = await useTool(h, A, "lean_check", { claim_id: c, theorem_name: "goldbach_small", source: SOURCE });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/^L1: Lean accepted goldbach_small \(Lean \(version 4\.24\.0\)\)\. Axioms used: propext\./);
    expect(r.text).toMatch(/does not yet carry the formal badge/);
    expect(h.eng.m.leancheck.get("L1")).toMatchObject({ ok: true, hasSorry: false, declaresAxioms: false, nonStandardAxioms: [], byModel: "astra62", revision: 1 });
    expect(label(h, c)).toBe("candidate");

    const self = await useTool(h, A, "review_formalization", { lean_check_id: "L1", faithful: true, notes: "Looks right to me." });
    expect(self.ok).toBe(false);
    expect(self.text).toMatch(/must come from a different model/);
    expect(label(h, c)).toBe("candidate");

    const other = await useTool(h, F, "review_formalization", { lean_check_id: "L1", faithful: true, notes: "Same range, same parity hypothesis, same conclusion; primes are Nat.Prime." });
    expect(other.ok, other.text).toBe(true);
    expect(other.text).toMatch(/Formally checked theorem/);
    expect(label(h, c)).toBe("formal");
    expect(h.eng.m.leancheck.get("L1")!.faithfulness).toMatchObject({ byModel: "fable52", faithful: true });

    // The badge belongs to the revision that was checked.
    const rev = await useTool(h, A, "revise_claim", { claim_id: c, change_note: "Extend the range.", statement: "Every even integer n with 4 <= n <= 60 is a sum of two primes." });
    expect(rev.ok, rev.text).toBe(true);
    expect(label(h, c)).not.toBe("formal");
  });

  it("an unfaithful formalization grants nothing", async () => {
    const h = lean();
    const c = await claim(h, A);
    await useTool(h, A, "lean_check", { claim_id: c, theorem_name: "goldbach_small", source: SOURCE });
    const r = await useTool(h, F, "review_formalization", { lean_check_id: "L1", faithful: false, notes: "The formal statement only covers n ≤ 30." });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/NOT faithful/);
    expect(label(h, c)).toBe("candidate");
  });

  it.each([
    ["a sorry in the file", { source: "theorem goldbach_small : True := by\n  sorry\n" }, {}, /contains sorry or admit/],
    ["an axiom declared in the file", { source: "axiom cheat : False\n\ntheorem goldbach_small : True := by\n  exact cheat.elim\n" }, {}, /declares its own axioms/],
    ["a proof resting on a non-standard axiom", {}, { axioms: ["propext", "Lean.ofReduceBool"] }, /non-standard axioms: Lean\.ofReduceBool/],
    ["a sorry that Lean reports as sorryAx", {}, { axioms: ["sorryAx"] }, /contains sorry or admit/],
    ["a file Lean rejects", {}, { ok: false, errors: ["4:2 error: unsolved goals"], axioms: [] }, /unsolved goals/],
    ["a run in which Lean did not report the axioms", {}, { axioms: undefined }, /did not report the axioms/],
    ["a kernel bypass", { source: "@[implemented_by foo] theorem goldbach_small : True := trivial\n" }, {}, /bypasses the kernel/],
  ] as [string, Record<string, unknown>, Partial<LeanOutcome>, RegExp][])("is not granted for %s", async (_name, args, outcome, message) => {
    const h = lean(outcome);
    const c = await claim(h, A);
    const r = await useTool(h, A, "lean_check", { claim_id: c, theorem_name: "goldbach_small", source: SOURCE, ...args });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/^L1: NOT accepted\./);
    expect(r.text).toMatch(message);
    const done = await useTool(h, F, "review_formalization", { lean_check_id: "L1", faithful: true, notes: "The statement matches the claim." });
    expect(done.ok, done.text).toBe(true);
    expect(label(h, c)).toBe("candidate");
    expect(events(h, "lean")[0]).toMatchObject({ level: "warn" });
  });

  it("records nothing when the checker itself fails, and refuses a file that does not state the named theorem", async () => {
    const h = lean({ infraError: "The Lean server closed the connection (HTTP 403)." });
    const c = await claim(h, A);
    const r = await useTool(h, A, "lean_check", { claim_id: c, theorem_name: "goldbach_small", source: SOURCE });
    expect(r.ok).toBe(false);
    expect(r.text).toBe("The Lean checker could not be used: The Lean server closed the connection (HTTP 403). No check was recorded.");
    expect(h.eng.all("leancheck")).toHaveLength(0);

    h.svc.leanOutcome = { ...LEAN_OK };
    const wrong = await useTool(h, A, "lean_check", { claim_id: c, theorem_name: "something_else", source: SOURCE });
    expect(wrong.ok).toBe(false);
    expect(wrong.text).toMatch(/does not declare a theorem or lemma named something_else/);
    // A name that only appears in a comment does not count.
    const hidden = await useTool(h, A, "lean_check", { claim_id: c, theorem_name: "goldbach_small", source: "-- theorem goldbach_small : True := trivial\ntheorem other : True := trivial\n" });
    expect(hidden.ok).toBe(false);
    expect(h.eng.all("leancheck")).toHaveLength(0);
  });

  it("a standing objection keeps the formal badge off until it is resolved", async () => {
    const h = lean();
    const c = await claim(h, A);
    await useTool(h, A, "lean_check", { claim_id: c, theorem_name: "goldbach_small", source: SOURCE });
    const obj = await useTool(h, F, "raise_objection", { claim_id: c, severity: "major", text: "The formal statement quantifies over Nat but the claim speaks of integers; say why this is the same." });
    expect(obj.ok, obj.text).toBe(true);
    await useTool(h, F, "review_formalization", { lean_check_id: "L1", faithful: true, notes: "Statement matches once the domain question is answered." });
    expect(label(h, c)).not.toBe("formal");
    expect(blockers(h, c)).toMatch(/objection/i);

    const x = h.eng.all("objection")[0];
    const resp = await useTool(h, A, "respond_objection", { objection_id: x.id, response: "rebut", text: "Every integer in the range 4..40 is a natural number, so the two statements coincide." });
    expect(resp.ok, resp.text).toBe(true);
    const res = await useTool(h, F, "resolve_objection", { objection_id: x.id, outcome: "resolved", text: "Agreed." });
    expect(res.ok, res.text).toBe(true);
    expect(label(h, c)).toBe("formal");
  });
});

describe("the instruction queue", () => {
  it("queued instructions can be edited, reordered and cancelled; each delivery to a lead is recorded", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h);
    const i1 = h.eng.addInstruction("Focus on n <= 20 first.");
    const i2 = h.eng.addInstruction("Use trial division only.", A);
    const i3 = h.eng.addInstruction("Ignore everything above 30.");
    expect([i1.id, i2.id, i3.id]).toEqual(["I1", "I2", "I3"]);
    expect(h.eng.addInstruction("   ")).toMatchObject({ ok: false, error: "The instruction is empty." });
    expect(h.eng.addInstruction("Hello", "lead-gpt55pro")).toMatchObject({ ok: false, error: "That lead is not taking part in this run." });
    expect(h.eng.addInstruction("Hello", "sub-1").ok).toBe(false);

    expect(h.eng.editInstruction("I1", "Focus on n <= 30 first.").ok).toBe(true);
    expect(h.eng.editInstruction("I1", "  ").ok).toBe(false);
    expect(h.eng.editInstruction("I9", "x").ok).toBe(false);
    expect(h.eng.cancelInstruction("I3").ok).toBe(true);
    expect(h.eng.cancelInstruction("I3").ok).toBe(false);
    expect(h.eng.reorderInstructions(["I2", "I1"]).ok).toBe(true);
    const queue = () =>
      h.eng
        .all("instruction")
        .filter((i) => i.status === "queued")
        .sort((a, b) => a.order - b.order)
        .map((i) => i.id);
    expect(queue()).toEqual(["I2", "I1"]);
    expect(h.eng.m.instruction.get("I1")!.editedAt).toBeDefined();

    // The queue is stored: it is the same after the host restarts.
    const h2 = h.reload();
    expect(
      h2.eng
        .all("instruction")
        .sort((a, b) => a.order - b.order)
        .map((i) => [i.id, i.status, i.text]),
    ).toEqual([
      ["I3", "cancelled", "Ignore everything above 30."],
      ["I2", "queued", "Use trial division only."],
      ["I1", "queued", "Focus on n <= 30 first."],
    ]);

    await h.eng.action("start");
    await h.drain({ until: (x) => x.eng.all("instruction").filter((i) => i.status === "delivered").length === 2, max: 60 });
    const I1 = h.eng.m.instruction.get("I1")!;
    const I2 = h.eng.m.instruction.get("I2")!;
    expect(I1.status).toBe("delivered");
    expect(I1.deliveries.map((d) => d.agentId).sort()).toEqual([A, F].sort());
    expect(I1.deliveredAt).toBeDefined();
    expect(I2.status).toBe("delivered");
    expect(I2.deliveries.map((d) => d.agentId)).toEqual([A]);
    expect(h.eng.m.instruction.get("I3")!.deliveries).toEqual([]);

    // They were queued before the first turn, so each lead finds them in its first briefing, in the user's order.
    const first = (model: string) => JSON.stringify(h.llm.requests.find((r) => r.model === model)!.messages);
    expect(first("astra62")).toContain("## Instructions from the user (in force)");
    expect(first("astra62")).toContain("- [User instruction I2, addressed to you alone] Use trial division only.\\n- [User instruction I1] Focus on n <= 30 first.");
    expect(first("fable52")).toContain("- [User instruction I1] Focus on n <= 30 first.");
    expect(first("fable52")).not.toContain("Use trial division only.");
    // The models really received them: the text is in the requests that went out.
    const sentTo = (model: string) => h.llm.requests.filter((r) => r.model === model).some((r) => JSON.stringify(r.messages).includes("[User instruction I1] Focus on n <= 30 first."));
    expect(sentTo("astra62")).toBe(true);
    expect(sentTo("fable52")).toBe(true);
    expect(JSON.stringify(h.llm.requests.map((r) => r.messages))).not.toContain("Ignore everything above 30.");

    const log = events(h, "instruction").map((e) => e.text);
    expect(log).toContain("Instruction I1 delivered to Astra 6.2.");
    expect(log).toContain("Instruction I1 delivered to Fable 5.2.");
    expect(log).toContain("Instruction I2 delivered to Astra 6.2.");
    expect(log).toContain("Instruction I3 cancelled before delivery.");
    expect(log.some((t) => /I2 delivered to Fable/.test(t))).toBe(false);

    // Once a lead has it, it can no longer be changed or withdrawn.
    expect(h.eng.editInstruction("I1", "Never mind.")).toMatchObject({ ok: false });
    expect((h.eng.editInstruction("I1", "Never mind.") as { error?: string }).error).toMatch(/already reached a lead/);
    expect(h.eng.cancelInstruction("I1").ok).toBe(false);
    expect(h.eng.m.instruction.get("I1")!.text).toBe("Focus on n <= 30 first.");

    await h.drain();
    expect(h.eng.run.status).toBe("completed");
  });

  it("an instruction sent while the leads are working reaches them at their next turn without stopping the run", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain({ until: (x) => x.eng.run.phase === "work" && x.llm.requests.length >= 6, max: 80 });
    expect(h.eng.run.status).toBe("running");
    const before = h.llm.requests.length;
    const r = h.eng.addInstruction("Also record the smallest prime used for each n.");
    expect(r.ok).toBe(true);
    expect(h.eng.run.status).toBe("running");
    await h.drain({ until: (x) => x.eng.m.instruction.get(r.id!)!.status === "delivered", max: 60 });
    const ins = h.eng.m.instruction.get(r.id!)!;
    expect(ins.status).toBe("delivered");
    expect(ins.deliveries).toHaveLength(2);
    // Mid-task it arrives as a message of its own, marked as coming from the user.
    const direct = ins.deliveries.flatMap((d) => h.eng.transcript(d.taskId)?.msgs ?? []).filter((m) => m.role === "user" && m.origin === "user");
    expect(direct.map((m) => (m.role === "user" ? m.text : ""))).toEqual([`[User instruction ${r.id}] Also record the smallest prime used for each n.`, `[User instruction ${r.id}] Also record the smallest prime used for each n.`]);
    const after = h.llm.requests.slice(before).filter((q) => JSON.stringify(q.messages).includes(`[User instruction ${r.id}] Also record the smallest prime used for each n.`));
    expect(after.length).toBeGreaterThanOrEqual(2);
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    // Every later briefing still carries the instruction, so it survives phase changes and context rebuilds.
    const last = h.llm.requests[h.llm.requests.length - 1];
    expect(JSON.stringify(last.messages)).toContain("Also record the smallest prime used for each n.");
  });

  it("an instruction for a single lead is not shown to the other", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain({ until: (x) => x.eng.run.phase === "work", max: 80 });
    const r = h.eng.addInstruction("Try a sieve instead of trial division.", F);
    await h.drain();
    expect(h.eng.m.instruction.get(r.id!)).toMatchObject({ status: "delivered", target: F });
    const seenBy = (model: string) => h.llm.requests.filter((q) => q.model === model).some((q) => JSON.stringify(q.messages).includes("Try a sieve instead of trial division."));
    expect(seenBy("fable52")).toBe(true);
    expect(seenBy("astra62")).toBe(false);
  });
});

describe("uploads", () => {
  const NOTES = "Lemma A. For every even n between 4 and 40 there is a prime p not exceeding n/2 such that n - p is also prime. The table below lists one such p for every n in the range.";

  it("files are stored once, become quotable sources and are refused when empty or too large", async () => {
    const h = makeHarness();
    const bytes = new TextEncoder().encode(NOTES);
    const r = await h.eng.addUpload({ name: "notes.md", mime: "text/markdown", bytes });
    expect(r.ok).toBe(true);
    expect(r.upload).toMatchObject({ id: "U1", name: "notes.md", kind: "text", size: bytes.length, sourceId: "S1", textChars: NOTES.length });
    expect(h.eng.m.source.get("S1")).toMatchObject({ kind: "upload", title: "notes.md", uploadId: "U1", textComplete: true });
    expect(h.eng.sourceText("S1")).toBe(NOTES);
    expect(h.eng.uploadBytes("U1")).toEqual(bytes);
    expect(h.eng.uploadBytes("U9")).toBeNull();

    const same = await h.eng.addUpload({ name: "copy-of-notes.md", mime: "text/markdown", bytes });
    expect(same.upload?.id).toBe("U1");
    expect(h.eng.all("upload")).toHaveLength(1);
    expect(h.eng.all("source")).toHaveLength(1);

    expect(await h.eng.addUpload({ name: "empty.txt", mime: "text/plain", bytes: new Uint8Array() })).toMatchObject({ ok: false, error: "The file is empty." });
    const big = await h.eng.addUpload({ name: "big.bin", mime: "application/octet-stream", bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1) });
    expect(big.ok).toBe(false);
    expect((big as { error?: string }).error).toMatch(/larger than 12 MB/);

    // A PDF arrives with the text the browser extracted; an image has no text and so no source.
    const pdf = await h.eng.addUpload({ name: "paper.pdf", mime: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]), text: "Extracted: Theorem 2. The set of exceptions below 4000 is empty.", pages: 12 });
    expect(pdf.upload).toMatchObject({ id: "U2", kind: "pdf", pages: 12, sourceId: "S2" });
    const img = await h.eng.addUpload({ name: "figure.png", mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) });
    expect(img.upload).toMatchObject({ id: "U3", kind: "image" });
    expect(img.upload!.sourceId).toBeUndefined();

    // The text is in the workspace index, and a quote from it can be machine-checked like any other source.
    expect(h.eng.search("prime not exceeding", 5).some((x) => x.ref === "S1")).toBe(true);
    atPhase(h, "work");
    const c = await claim(h, A, { proposed_label: "partial", basis: "retrieved", argument: undefined });
    const ev = await useTool(h, A, "add_evidence", { claim_id: c, kind: "citation", summary: "Lemma A in the user's notes.", source_id: "S1", quote: "there is a prime p not exceeding n/2 such that n - p is also prime" });
    expect(ev.ok, ev.text).toBe(true);
    expect(ev.text).toMatch(/found verbatim in S1/);

    // Stored: all of it is there after a restart.
    const h2 = h.reload();
    expect(h2.eng.all("upload").map((u) => u.id).sort()).toEqual(["U1", "U2", "U3"]);
    expect(h2.eng.uploadBytes("U1")).toEqual(bytes);
    expect(h2.eng.sourceText("S2")).toContain("Theorem 2.");
  });

  it("files added at setup are in the first briefing; files added mid-run are announced to the working leads", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h);
    await h.eng.addUpload({ name: "notes.md", mime: "text/markdown", bytes: new TextEncoder().encode(NOTES) });
    await h.eng.action("start");
    await h.drain({ until: (x) => x.eng.run.phase === "work" && x.llm.requests.length >= 6, max: 80 });
    expect(JSON.stringify(h.llm.requests[0].messages)).toContain('U1 \\"notes.md\\" (text) — extracted text: S1');

    const before = h.llm.requests.length;
    const late = await h.eng.addUpload({ name: "table.csv", mime: "text/csv", bytes: new TextEncoder().encode("n,p,q\n4,2,2\n6,3,3\n8,3,5\n10,3,7\n12,5,7\n") });
    expect(late.upload).toMatchObject({ id: "U2", kind: "text", sourceId: "S2" });
    expect(h.eng.run.status).toBe("running");
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    const told = h.llm.requests.slice(before).filter((q) => JSON.stringify(q.messages).includes('[Platform] The user added a file to the run:\\n- U2 \\"table.csv\\" (text) — extracted text is S2 (read_item)'));
    expect(told.length).toBeGreaterThanOrEqual(1);
    expect(new Set(told.map((q) => q.model))).toEqual(new Set(["astra62", "fable52"]));
    expect(events(h, "upload").map((e) => e.text)).toEqual(['The user added "notes.md" (text, text held as S1).', 'The user added "table.csv" (text, text held as S2).']);
    expect(h.eng.export("md").content).toContain("table.csv");
  });
});

describe("checkpoints and branches", () => {
  it("a checkpoint can be branched into a new run that keeps the ledger and has its own subagent allowance", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h, { delegate: 1 });
    await h.eng.action("start");
    await h.drain();
    const ck = h.eng.all("checkpoint");
    expect(ck).toHaveLength(1);
    expect(ck[0]).toMatchObject({ id: "K1", cycle: 1 });
    expect(h.eng.exportCheckpoint("K9")).toBeNull();
    const exp = h.eng.exportCheckpoint("K1")!;
    expect(exp).toMatchObject({ runId: "run-test", checkpointId: "K1", cycle: 1, title: "Test run" });
    expect(exp.config.goal).toBe(h.eng.run.config.goal);

    const b = makeHarness({ init: false });
    expect(b.eng.loaded).toBe(false);
    b.eng.init({ id: "run-branch", ownerHash: "owner-hash", config: { ...exp.config, title: "Test run (branch)" }, import: exp, branchedFrom: { runId: exp.runId, checkpointId: exp.checkpointId } });
    expect(b.eng.run).toMatchObject({ id: "run-branch", status: "draft", branchedFrom: { runId: "run-test", checkpointId: "K1" } });
    expect(b.eng.run.config.title).toBe("Test run (branch)");
    expect(events(b, "run").map((e) => e.text)).toContain("Branch created from checkpoint K1 of an earlier run.");

    const ids = (x: Harness, kind: "claim" | "evidence" | "review" | "experiment") =>
      x.eng
        .all(kind)
        .map((e) => e.id)
        .sort();
    for (const kind of ["claim", "evidence", "review", "experiment"] as const) expect(ids(b, kind), kind).toEqual(ids(h, kind));
    expect(b.eng.all("claim").map((c) => [c.id, c.label])).toEqual(h.eng.all("claim").map((c) => [c.id, c.label]));
    // Spending, subagents and the transcript belong to the old run.
    expect(b.eng.run.spend.calls).toBe(0);
    expect(b.eng.run.subagents.created).toBe(0);
    expect(b.eng.all("agent").filter((a) => a.kind === "subagent")).toHaveLength(0);
    expect(b.eng.all("task")).toHaveLength(0);

    // New items continue the numbering instead of overwriting what was imported.
    atPhase(b, "work");
    const c = await claim(b, A, { statement: "Every even integer n with 42 <= n <= 60 is a sum of two primes." });
    expect(c).toBe("C3");
    const sp = b.eng.spawn(b.eng.m.agent.get(A)!, [{ question: "Enumerate the prime pairs for every even n from 42 to 60.", role: "Computation", context: "Extends C1 to a longer range.", sources: [], expectedOutput: "A table of pairs.", completionCriteria: "All ten cases listed.", dependsOn: [], maxTurns: 8, budgetUsd: 5 }]);
    expect(sp.created.map((a) => a.id)).toEqual(["sub-3"]);
    expect(b.eng.run.subagents.created).toBe(1);

    // The original run is untouched.
    expect(h.eng.all("claim")).toHaveLength(2);
    expect(h.eng.run.subagents.created).toBe(2);
  });
});

describe("email alerts", () => {
  it("writes to the owner at once when the goal is reached", async () => {
    const h = makeHarness();
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.goalReached).toBe(true);
    const goal = h.svc.emails.filter((m) => m.subject === "Scholium: goal reached — Test run");
    expect(goal).toHaveLength(1);
    expect(goal[0].text).toContain('Goal reached: C1 stands as "Model-reviewed argument".');
    expect(goal[0].text).toMatch(/Spend: \$\d/);
    expect(goal[0].text).toContain("https://scholium.test");
    const logs = h.eng.all("email");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ kind: "goal", status: "sent", to: "ow•••@example.com", subject: "Scholium: goal reached — Test run" });
    expect(events(h, "email").map((e) => e.text)).toEqual(['Email sent to ow•••@example.com: "Scholium: goal reached — Test run".']);
    // The full address is never part of what the browser is given.
    expect(JSON.stringify(h.eng.publicSnapshot())).not.toContain("owner@example.com");
  });

  it("sends a progress digest at the interval the user chose, and not more often", async () => {
    const h = makeHarness({ config: { alerts: { enabled: true, intervalMin: 30, onGoal: true, onAttention: true } } });
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    const t0 = h.eng.run.startedAt!;
    expect(h.eng.run.nextDigestAt).toBe(t0 + 30 * 60000);
    await h.drain({ until: (x) => x.eng.run.phase === "work", max: 80 });
    expect(h.svc.emails).toHaveLength(0);

    h.svc.clock.t = t0 + 29 * 60000;
    await h.eng.tick();
    await h.eng.idle();
    expect(h.svc.emails).toHaveLength(0);

    h.svc.clock.t = t0 + 30 * 60000 + 1000;
    await h.eng.tick();
    await h.eng.idle();
    expect(h.svc.emails.map((m) => m.subject)).toEqual(["Scholium update — Test run"]);
    expect(h.svc.emails[0].text).toMatch(/Stage: cycle 1/);
    expect(h.eng.run.nextDigestAt).toBe(h.eng.run.lastDigestAt! + 30 * 60000);

    await h.eng.tick();
    await h.eng.idle();
    expect(h.svc.emails).toHaveLength(1);

    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    expect(h.svc.emails.map((m) => m.subject)).toEqual(["Scholium update — Test run", "Scholium: goal reached — Test run"]);
    expect(h.eng.all("email").map((m) => m.kind)).toEqual(["digest", "goal"]);
  });

  it("a rejected email is logged as failed and does not stop the research", async () => {
    const h = makeHarness();
    h.svc.emailMode = "failed";
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    expect(h.svc.emails).toHaveLength(0);
    expect(h.eng.all("email")).toHaveLength(1);
    expect(h.eng.all("email")[0]).toMatchObject({ kind: "goal", status: "failed", detail: "HTTP 403 from the email provider" });
    const ev = events(h, "email");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ level: "warn" });
    expect(ev[0].text).toBe('Email "Scholium: goal reached — Test run" was not delivered: HTTP 403 from the email provider');
  });

  it("without an email key the alert is recorded as not sent, once per kind, instead of being claimed", async () => {
    const h = makeHarness({ config: { alerts: { enabled: true, intervalMin: 30, onGoal: true, onAttention: true } } });
    h.svc.emailMode = "skipped";
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    const t0 = h.eng.run.startedAt!;
    await h.drain({ until: (x) => x.eng.run.phase === "work", max: 80 });
    for (const min of [31, 62, 93]) {
      h.svc.clock.t = t0 + min * 60000;
      await h.eng.tick();
      await h.eng.idle();
    }
    const digests = h.eng.all("email").filter((m) => m.kind === "digest");
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ status: "skipped", detail: "No email key is configured." });
    expect(h.eng.run.counters.skipmail_digest).toBe(1);
    await h.drain();
    expect(h.eng.all("email").map((m) => [m.kind, m.status])).toEqual([
      ["digest", "skipped"],
      ["goal", "skipped"],
    ]);
    expect(events(h, "email").every((e) => e.level === "warn" && /was not sent: No email key is configured\./.test(e.text))).toBe(true);
  });

  it("sends nothing when alerts are switched off", async () => {
    const h = makeHarness({ config: { alerts: { enabled: false, intervalMin: 30, onGoal: true, onAttention: true } } });
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    expect(h.svc.emails).toHaveLength(0);
    expect(h.eng.all("email")).toHaveLength(0);
  });
});

describe("Google Drive", () => {
  const forcePass = async (h: Harness) => {
    h.eng.run.driveLastSyncAt = undefined;
    await h.eng.tick();
    await h.eng.idle();
  };
  const names = (h: Harness) => [...h.svc.driveFiles.values()].map((f) => f.name).sort();

  it("saves the report, the ledger, code and artifacts to a folder for the run and rewrites only what changed", async () => {
    const h = makeHarness({ config: { drive: true } });
    h.svc.driveConnected = true;
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    await forcePass(h);
    expect(h.svc.driveFolders).toEqual(["Test run"]);
    expect(h.eng.run.driveFolderUrl).toBe("https://drive.google.com/drive/folders/folder-1");
    expect(h.eng.run.driveError).toBeUndefined();
    const have = names(h);
    for (const n of ["report.md", "report.tex", "ledger.json", "experiment-E1.py", "experiment-E2.py"]) expect(have, n).toContain(n);
    expect(new Set(have).size).toBe(have.length);
    const file = (name: string) => [...h.svc.driveFiles.values()].find((f) => f.name === name)!;
    expect(file("report.md").content).toContain("## Verification record");
    expect(file("report.md").folderId).toBe("folder-1");
    expect(JSON.parse(file("ledger.json").content).run[0].id).toBe("run-test");
    expect(file("experiment-E1.py").content).toContain("print(");
    expect(h.eng.all("drivefile").map((d) => d.name).sort()).toEqual(have);
    expect(events(h, "drive").map((e) => e.text)).toContain("A folder for this run was created in Google Drive.");

    const writes = file("experiment-E1.py").writes;
    const count = h.svc.driveFiles.size;
    await forcePass(h);
    await forcePass(h);
    expect(file("experiment-E1.py").writes).toBe(writes);
    expect(h.svc.driveFiles.size).toBe(count);
    expect(h.svc.driveFolders).toHaveLength(1);

    // A new artifact is added on the next pass.
    atPhase(h, "work");
    const art = await useTool(h, A, "save_artifact", { title: "Notes on the pairs", kind: "document", filename: "pairs.md", content: "The pairs used for n = 4 and n = 6 are (2, 2) and (3, 3)." });
    expect(art.ok, art.text).toBe(true);
    h.eng.run.status = "completed";
    await forcePass(h);
    expect(names(h).some((n) => /^artifact-A\d+-pairs\.md$/.test(n))).toBe(true);
  });

  it("shows a Drive failure once, keeps the run going, and recovers when Drive is back", async () => {
    const h = makeHarness({ config: { drive: true } });
    h.svc.driveConnected = true;
    h.svc.driveFail = "HTTP 403 from Google Drive: insufficient permissions";
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    await forcePass(h);
    await forcePass(h);
    expect(h.eng.run.driveError).toBe("HTTP 403 from Google Drive: insufficient permissions");
    expect(h.svc.driveFiles.size).toBe(0);
    const warns = events(h, "drive").filter((e) => e.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].text).toBe("Saving to Google Drive failed: HTTP 403 from Google Drive: insufficient permissions");

    h.svc.driveFail = null;
    await forcePass(h);
    expect(h.eng.run.driveError).toBeUndefined();
    expect(events(h, "drive").map((e) => e.text)).toContain("Google Drive is reachable again.");
    expect(names(h)).toContain("report.md");
  });

  it("says so when saving is switched on but no Google account is connected", async () => {
    const h = makeHarness({ config: { drive: true } });
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain();
    expect(h.eng.run.status).toBe("completed");
    expect(h.eng.run.driveError).toBe("Google Drive is not connected.");
    expect(h.svc.driveFolders).toHaveLength(0);
    expect(events(h, "drive").filter((e) => e.level === "warn").map((e) => e.text)).toEqual(["Saving to Google Drive failed: Google Drive is not connected."]);
  });

  it("does nothing when saving to Drive is off", async () => {
    const h = makeHarness();
    h.svc.driveConnected = true;
    h.llm.script = cooperative(h);
    await h.eng.action("start");
    await h.drain();
    expect(h.svc.driveFolders).toHaveLength(0);
    expect(h.svc.driveFiles.size).toBe(0);
    expect(events(h, "drive")).toHaveLength(0);
  });
});
