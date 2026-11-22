// Method notes: working advice the models may propose, test and adopt, under a policy they cannot change.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Chip, ErrorNote, Loading, usd } from "@/components/bits";
import { MathText } from "@/components/Markdown";
import { Field } from "@/components/ConfigForm";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, errorText, type StrategyVerb } from "@/lib/api";
import type { StrategyVersion } from "@/shared/types";

type Status = StrategyVersion["status"];
const AREAS: { value: StrategyVersion["area"]; label: string }[] = [
  { value: "lead", label: "Lead instructions" },
  { value: "subagent", label: "Sub-agent instructions" },
  { value: "reviewer", label: "Reviewer instructions" },
  { value: "delegation", label: "Delegation" },
  { value: "tools", label: "Tool use" },
  { value: "retrieval", label: "Retrieval" },
];
const TONE: Record<Status, "muted" | "live" | "ok" | "warn" | "bad"> = { proposed: "muted", evaluated: "live", adopted: "ok", rejected: "bad", rolled_back: "muted", needs_review: "warn" };
const SAY: Record<Status, string> = { proposed: "proposed", evaluated: "tested", adopted: "in use", rejected: "rejected", rolled_back: "rolled back", needs_review: "waiting for you" };
const DONE: Record<StrategyVerb, string> = { propose: "Proposal recorded", evaluate: "Test finished", adopt: "Note adopted", reject: "Proposal rejected", rollback: "Note rolled back" };
const BTN = "press flex h-8 items-center gap-1.5 rounded-sm border bg-background px-2.5 text-[0.82rem] hover:border-foreground/50 disabled:opacity-50";
const EMPTY = { area: "lead" as StrategyVersion["area"], title: "", text: "", reason: "" };

export default function Methods() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["strategy"], queryFn: ({ signal }) => api.strategy(signal) });
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);

  const act = async (verb: StrategyVerb, body: Record<string, unknown>): Promise<boolean> => {
    setBusy(`${verb}:${String(body.id ?? "")}`);
    try {
      const r = await api.strategyAct(verb, body);
      queryClient.setQueryData(["strategy"], r);
      toast.success(DONE[verb]);
      return true;
    } catch (e) {
      // A refused proposal is still kept in the history, with the reason it was blocked.
      void queryClient.invalidateQueries({ queryKey: ["strategy"] });
      toast.error("Not done", { description: errorText(e), duration: 12_000 });
      return false;
    } finally {
      setBusy(null);
      if (verb === "evaluate") void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    }
  };

  if (q.isPending) return <Loading what="Loading the method notes" />;
  if (q.isError) return <ErrorNote error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const versions = [...d.versions].sort((a, b) => b.n - a.n);
  const spin = (key: string) => busy === key && <Loader2 className="h-3.5 w-3.5 animate-spin" />;

  return (
    <div className="space-y-8">
      <div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          A method note is a short piece of working advice added to the models' instructions, below a line that says the built-in instructions win. Notes are proposed, tested, adopted and rolled back on this page. The models cannot yet propose one from inside a run. Every model call
          records which version of the instructions it ran under ({d.version} now).
        </p>
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium">What no note can change ({d.policy.length} fixed rules)</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {d.policy.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
        <details className="mt-2">
          <summary className="cursor-pointer text-sm font-medium">What the test checks ({d.probes.length} probes)</summary>
          <p className="mt-2 text-sm text-muted-foreground">Each probe is run with the current instructions and again with the note added. The test can show that a note does no harm on these cases. It cannot show that a note makes research better.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {d.probes.map((p) => (
              <li key={p.id}>
                {p.what}
                {p.safety ? " (safety)" : ""}
              </li>
            ))}
          </ul>
        </details>
      </div>

      <ul>
        {versions.length === 0 && <li className="text-sm text-muted-foreground">No note has been proposed yet. The models work from the built-in instructions alone.</li>}
        {versions.map((v) => {
          const e = v.evaluation;
          const inUse = d.active.includes(v.id);
          const open = v.n > 0 && (v.status === "proposed" || v.status === "evaluated" || v.status === "needs_review");
          return (
            <li key={v.id} className="border-t py-4 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="tabular text-sm text-muted-foreground">{v.id}</span>
                <span className="font-medium">{v.title}</span>
                <Chip tone={inUse ? "ok" : TONE[v.status]}>{inUse ? "in use" : SAY[v.status]}</Chip>
                <span className="text-xs text-muted-foreground">
                  {AREAS.find((a) => a.value === v.area)?.label} · by {v.proposedBy} · {new Date(v.at).toLocaleString()}
                </span>
              </div>
              {v.text && <p className="mt-2 whitespace-pre-wrap break-words font-serif text-[0.98rem] leading-relaxed"><MathText text={v.text} /></p>}
              {v.reason && <p className="mt-1.5 text-sm text-muted-foreground">Why: {v.reason}</p>}
              {!v.lint.ok && <p className="gloss mt-2 text-sm">Blocked by the fixed rules. {v.lint.problems.join(" ")}</p>}
              {e && (
                <p className="mt-2 text-sm">
                  Tested {new Date(e.at).toLocaleString()}: {e.candidate} with the note against {e.baseline} without, safety probes {e.safetyOk ? "passed" : "failed"}, cost {usd(e.costUsd)}. <span className="text-muted-foreground">{e.detail}</span>
                </p>
              )}
              {v.note && <p className="mt-1 text-sm text-muted-foreground">Note: {v.note}</p>}
              {(open || inUse) && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {open && v.lint.ok && (
                    <button type="button" className={BTN} disabled={busy !== null} onClick={() => void act("evaluate", { id: v.id })} title="Runs real model calls. Their cost counts against the monthly ceiling.">
                      {spin(`evaluate:${v.id}`)} {e ? "Test again" : "Test"}
                    </button>
                  )}
                  {open && v.lint.ok && (
                    <button type="button" className={BTN} disabled={busy !== null} onClick={() => void act("adopt", { id: v.id })}>
                      {spin(`adopt:${v.id}`)} Adopt
                    </button>
                  )}
                  {open && (
                    <button type="button" className={BTN} disabled={busy !== null} onClick={() => void act("reject", { id: v.id })}>
                      {spin(`reject:${v.id}`)} Reject
                    </button>
                  )}
                  {inUse && (
                    <button type="button" className={BTN} disabled={busy !== null} onClick={() => void act("rollback", { id: v.id })}>
                      {spin(`rollback:${v.id}`)} Roll back
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <form
        className="space-y-4 border-t pt-6"
        onSubmit={(ev) => {
          ev.preventDefault();
          void act("propose", form).then((ok) => ok && setForm(EMPTY));
        }}
      >
        <h3 className="eyebrow">Propose a note yourself</h3>
        <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
          <Field label="What it changes">
            <select aria-label="What it changes" value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value as StrategyVersion["area"] })} className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm">
              {AREAS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <Input aria-label="Title" value={form.title} maxLength={100} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="State lemmas before using them" />
          </Field>
        </div>
        <Field label="The note" hint="Plain working advice. Anything about permissions, credentials, limits, security or the app itself is refused.">
          <Textarea aria-label="The note" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} className="min-h-[5.5rem]" />
        </Field>
        <Field label="Why">
          <Input aria-label="Why" value={form.reason} maxLength={600} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Field>
        <button type="submit" disabled={busy !== null || !form.text.trim() || !form.reason.trim()} className="press flex h-9 items-center gap-2 rounded-sm bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {spin("propose:")} Propose
        </button>
      </form>

      {d.log.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">History ({d.log.length})</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {[...d.log]
              .reverse()
              .slice(0, 80)
              .map((l, i) => (
                <li key={`${l.at}-${i}`} className="flex flex-wrap gap-x-2">
                  <span className="tabular text-muted-foreground">{new Date(l.at).toLocaleString()}</span>
                  <span>
                    {l.action} {l.versionId}
                  </span>
                  <span className="text-muted-foreground">{l.detail}</span>
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}
