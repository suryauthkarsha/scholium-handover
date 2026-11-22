// Setting up a research project: the problem, the team, the limits, the tools and the material to study.
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, Play, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { ErrorNote, Section, usd } from "@/components/bits";
import { AlertFields, Choice, Field, LimitFields, TeamFields, ToolFields } from "@/components/ConfigForm";
import { FileDrop } from "@/components/FileDrop";
import { Page, useWorkspace } from "@/components/Shell";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, errorText } from "@/lib/api";
import { fileSize, MAX_FILE_BYTES, sendFiles, type Sent } from "@/lib/files";
import { defaultConfig, LABEL_NAMES, type DiagnosticResult, type Label, type RunConfig, type RunTools } from "@/shared/types";

export const STANDARDS: { value: Label; label: string; note: string }[] = [
  { value: "numerical", label: LABEL_NAMES.numerical, note: "Computed evidence is what you are after. It supports a statement; it does not prove it." },
  { value: "partial", label: LABEL_NAMES.partial, note: "A proved special case or a clean reduction would count." },
  { value: "candidate", label: LABEL_NAMES.candidate, note: "A complete written argument that nobody else has checked yet." },
  { value: "reviewed", label: LABEL_NAMES.reviewed, note: "A different model has gone through it and no objection is left standing. Agreement between models is still not proof." },
  { value: "formal", label: LABEL_NAMES.formal, note: "Lean has compiled the statement and its proof. Needs a Lean server." },
];

const TOOL_WORDS: [keyof RunTools, RegExp][] = [
  ["web", /duckduckgo|wikipedia|web/i],
  ["literature", /arxiv|crossref|literature/i],
  ["sandbox", /sandbox|python/i],
  ["sage", /sage/i],
  ["lean", /lean/i],
  ["oeis", /oeis/i],
];

/** What the last connection check found wrong with each tool, in the server's words. */
export function toolNotes(diagnostics: DiagnosticResult[] | undefined): Partial<Record<keyof RunTools, string>> {
  const out: Partial<Record<keyof RunTools, string>> = {};
  for (const d of diagnostics ?? []) {
    if (d.ok) continue;
    const hit = TOOL_WORDS.find(([, re]) => re.test(d.check));
    if (hit && !out[hit[0]]) out[hit[0]] = `The last connection check failed: ${d.detail}`;
  }
  return out;
}

/** The monthly ceiling, changeable where the run's own limit is chosen. The server stores it; nothing is assumed here. */
function CeilingBox({ capUsd, disabled }: { capUsd: number; disabled: boolean }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(String(capUsd));
  const [saving, setSaving] = useState(false);
  const n = Number(text);
  const valid = text.trim() !== "" && Number.isFinite(n) && n >= 1 && n <= 5000;
  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.saveSettings({ monthlyCapUsd: n });
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      toast.success("Monthly ceiling saved");
    } catch (e) {
      toast.error("The ceiling was not saved", { description: errorText(e) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mb-6">
      <div className="flex max-w-md items-end gap-2">
        <Field label="Monthly ceiling for all projects (USD)">
          <Input aria-label="Monthly ceiling in dollars" inputMode="decimal" value={text} disabled={disabled || saving} onChange={(e) => setText(e.target.value)} />
        </Field>
        <button type="button" disabled={disabled || saving || !valid || n === capUsd} onClick={() => void save()} className="press h-10 rounded-sm border px-4 text-sm font-medium disabled:opacity-50">
          {saving ? "Saving" : "Save"}
        </button>
      </div>
      <p className="mt-1.5 max-w-2xl text-[0.82rem] leading-snug text-muted-foreground">
        Yours to set, between $1 and $5,000. No run can take the month past it. It is the app's own estimate in dollars of model use, paid from the credits already in your plan; it is not a charge.
      </p>
    </div>
  );
}

export default function NewRun() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [config, setConfig] = useState<RunConfig>(() => defaultConfig());
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const top = useRef<HTMLDivElement>(null);

  const settings = ws.data?.settings;
  const budget = ws.data?.budget;
  const notes = useMemo(() => toolNotes(ws.data?.diagnostics), [ws.data?.diagnostics]);
  const set = (p: Partial<RunConfig>): void => setConfig((c) => ({ ...c, ...p }));

  const addFiles = (picked: File[]): void => {
    const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES);
    for (const f of tooBig) toast.error(`${f.name} is larger than ${fileSize(MAX_FILE_BYTES)}`, { description: "It was not added." });
    setFiles((cur) => {
      const seen = new Set(cur.map((f) => `${f.name}:${f.size}`));
      return [...cur, ...picked.filter((f) => f.size <= MAX_FILE_BYTES && !seen.has(`${f.name}:${f.size}`))].slice(0, 40);
    });
  };

  const submit = async (start: boolean): Promise<void> => {
    setError(null);
    if (!config.goal.trim()) {
      setError(new Error("Describe the problem first. The goal cannot be empty."));
      top.current?.scrollIntoView({ block: "center" });
      return;
    }
    setBusy("Creating the project");
    let id: string;
    try {
      id = (await api.createRun(config)).id;
    } catch (e) {
      setError(e);
      setBusy(null);
      top.current?.scrollIntoView({ block: "center" });
      return;
    }
    const sent: Sent[] = [];
    if (files.length) {
      setBusy(`Adding file 1 of ${files.length}`);
      await sendFiles(id, files, (s) => {
        sent.push(s);
        if (sent.length < files.length) setBusy(`Adding file ${sent.length + 1} of ${files.length}`);
      });
    }
    let refusal = "";
    if (start) {
      setBusy("Starting the run");
      try {
        await api.action(id, "start");
      } catch (e) {
        refusal = errorText(e);
      }
    }
    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    for (const s of sent) {
      if (!s.ok) toast.error(`${s.name} was not added`, { description: s.note });
      else if (s.note) toast.message(s.name, { description: s.note });
    }
    if (refusal) toast.error("The project was created but the run did not start", { description: refusal, duration: 12_000 });
    navigate(`/r/${id}`);
  };

  const working = busy !== null;

  return (
    <Page eyebrow="New project" title="What should be worked out?">
      <div className="space-y-12">
        <div ref={top}>{error !== null && <ErrorNote error={error} />}</div>

        <Section title="The problem">
          <div className="space-y-6">
            <Field label="Goal" hint="State it as precisely as you can: the objects, the hypotheses, and what is to be shown or found. The leads begin by restating it and listing what is ambiguous.">
              <Textarea
                aria-label="Goal"
                value={config.goal}
                disabled={working}
                onChange={(e) => set({ goal: e.target.value })}
                placeholder="For example: determine all integers n ≥ 1 for which n² + 1 divides n! + 1, with proof."
                className="min-h-[10rem] font-serif text-[1.08rem] leading-relaxed"
              />
            </Field>
            <Field label="What counts as done" hint="Optional. In your own words: what you would accept as an answer, and what you would not.">
              <Textarea aria-label="What counts as done" value={config.acceptance} disabled={working} onChange={(e) => set({ acceptance: e.target.value })} className="min-h-[5rem]" placeholder="A complete proof, or a counterexample that I can check by hand." />
            </Field>
            <Field label="Required standard" hint="The run only reports the goal as reached when a claim answering it stands at this level or higher. Labels are given by the platform from the evidence on record, not by the models.">
              <Choice label="Required standard" value={config.standard} options={STANDARDS} onChange={(standard) => set({ standard })} disabled={working} />
            </Field>
            <Field label="Name" hint="Optional. Without one, the first words of the goal are used.">
              <Input aria-label="Name" value={config.title} disabled={working} maxLength={160} onChange={(e) => set({ title: e.target.value })} placeholder="A short name for the sidebar" />
            </Field>
          </div>
        </Section>

        <Section title="Material to study" aside={files.length ? `${files.length} chosen` : "optional"}>
          <FileDrop onFiles={addFiles} disabled={working} />
          {files.length > 0 && (
            <ul className="mt-3 divide-y divide-border rounded-sm border">
              {files.map((f, i) => (
                <li key={`${f.name}:${f.size}`} className="flex items-center gap-3 px-3 py-2 text-[0.93rem]">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="tabular shrink-0 text-[0.8rem] text-muted-foreground">{fileSize(f.size)}</span>
                  <button type="button" aria-label={`Remove ${f.name}`} disabled={working} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} className="press rounded-sm p-1 text-muted-foreground hover:text-foreground">
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[0.82rem] text-muted-foreground">More can be added at any time while the run is working.</p>
        </Section>

        <Section title="The team">
          <TeamFields config={config} onChange={setConfig} disabled={working} />
        </Section>

        <Section title="Limits">
          {budget && <CeilingBox key={budget.capUsd} capUsd={budget.capUsd} disabled={working} />}
          <LimitFields config={config} onChange={setConfig} disabled={working} availableUsd={budget?.availableUsd} />
        </Section>

        <Section title="Tools">
          <ToolFields config={config} onChange={setConfig} disabled={working} settings={settings} notes={notes} />
        </Section>

        <Section title="Keeping you informed">
          <AlertFields config={config} onChange={setConfig} disabled={working} settings={settings} />
        </Section>

        <div className="hairline sticky bottom-0 -mx-5 flex flex-wrap items-center gap-3 border-t bg-background/95 px-5 py-4 backdrop-blur sm:-mx-10 sm:px-10">
          <button type="button" disabled={working} onClick={() => void submit(true)} className="press inline-flex h-11 items-center gap-2 rounded-sm bg-foreground px-5 font-medium text-background disabled:opacity-60">
            {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {busy ?? "Create and start"}
          </button>
          <button type="button" disabled={working} onClick={() => void submit(false)} className="press h-11 rounded-sm border px-4 font-medium disabled:opacity-60">
            Save as a draft
          </button>
          <p className="min-w-[14rem] flex-1 text-[0.82rem] leading-snug text-muted-foreground">
            {budget
              ? `Starting sets aside ${usd(Math.min(config.limits.spendUsd, Math.max(0, budget.availableUsd)))} of model use. This month ${usd(budget.spentUsd)} is spent and ${usd(Math.max(0, budget.availableUsd))} is free under your ${usd(budget.capUsd)} ceiling.${config.limits.untilSpend ? " This run keeps working until its spending limit is reached." : ""}`
              : "Starting sets the run's spending limit aside from this month's ceiling."}{" "}
            The app only draws on your existing plan. It cannot buy credits or switch on billing.
          </p>
        </div>
      </div>
    </Page>
  );
}
