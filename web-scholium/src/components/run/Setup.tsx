// Changing a project's setup after it was created: the wording, the team, the limits, the tools and the reports.
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ErrorNote } from "@/components/bits";
import { AlertFields, Choice, Field, LimitFields, TeamFields, ToolFields } from "@/components/ConfigForm";
import { useWorkspace } from "@/components/Shell";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { STANDARDS, toolNotes } from "@/pages/NewRun";
import type { RunConfig } from "@/shared/types";

import { useRunCtx } from "./ctx";

const KEYS: (keyof RunConfig)[] = ["title", "goal", "acceptance", "standard", "leads", "subagentModels", "mode", "speed", "limits", "tools", "alerts", "drive"];

/** Only what was actually changed is sent, so a save never overwrites something the form did not touch. */
function changed(before: RunConfig, after: RunConfig): Partial<RunConfig> {
  const patch: Record<string, unknown> = {};
  for (const k of KEYS) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) patch[k] = after[k];
  return patch as Partial<RunConfig>;
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-5 border-t pt-6">
      <h3 className="eyebrow">{title}</h3>
      {children}
    </section>
  );
}

/** Mounted only while open, so the form always starts from the setup the server holds at that moment. */
export default function Setup({ onClose }: { onClose: () => void }) {
  const { id, run, store, view } = useRunCtx();
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const [start] = useState<RunConfig>(() => run.config);
  const [config, setConfig] = useState<RunConfig>(() => run.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const draft = run.status === "draft";
  const notes = useMemo(() => toolNotes(ws.data?.diagnostics), [ws.data?.diagnostics]);
  const patch = useMemo(() => changed(start, config), [start, config]);
  const dirty = Object.keys(patch).length > 0;
  const set = (p: Partial<RunConfig>): void => setConfig((c) => ({ ...c, ...p }));

  const save = async (): Promise<void> => {
    if (!dirty) return onClose();
    if (draft && !config.goal.trim()) return setError(new Error("The goal cannot be empty."));
    setSaving(true);
    setError(null);
    try {
      await api.config(id, patch);
      void queryClient.invalidateQueries({ queryKey: ["workspace"] });
      if (view.link !== "live") void store.resync();
      toast.success("Setup saved", { description: draft ? undefined : "It applies from the next step. Model calls already under way are not interrupted." });
      onClose();
    } catch (e) {
      setError(e);
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="flex max-h-[92dvh] w-[calc(100vw-1.5rem)] max-w-3xl flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle className="font-serif text-xl font-medium">Project setup</DialogTitle>
          <DialogDescription>
            {draft ? "Nothing has run yet, so everything can still be changed." : "The goal is fixed once a run has started. Everything else can be changed at any time."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-6 py-6">
          {error !== null && <ErrorNote error={error} />}

          <div className="space-y-5">
            <Field label="Title">
              <Input aria-label="Title" value={config.title} maxLength={160} disabled={saving} onChange={(e) => set({ title: e.target.value })} />
            </Field>
            {draft ? (
              <Field label="Goal">
                <Textarea aria-label="Goal" value={config.goal} disabled={saving} onChange={(e) => set({ goal: e.target.value })} className="min-h-[8rem] font-serif text-[1.05rem] leading-relaxed" />
              </Field>
            ) : (
              <p className="gloss text-sm text-muted-foreground">To steer the work in a new direction, send an instruction to the leads. To work on a different problem, start a new project.</p>
            )}
            <Field label="What counts as done">
              <Textarea aria-label="What counts as done" value={config.acceptance} disabled={saving} onChange={(e) => set({ acceptance: e.target.value })} className="min-h-[4.5rem]" />
            </Field>
            <Choice label="Required standard" value={config.standard} options={STANDARDS} onChange={(standard) => set({ standard })} disabled={saving} />
          </div>

          <Part title="Team">
            <TeamFields config={config} onChange={setConfig} disabled={saving} />
          </Part>
          <Part title="Limits">
            <LimitFields config={config} onChange={setConfig} disabled={saving} availableUsd={ws.data?.budget?.availableUsd} />
          </Part>
          <Part title="Tools">
            <ToolFields config={config} onChange={setConfig} disabled={saving} settings={ws.data?.settings} notes={notes} />
          </Part>
          <Part title="Reports">
            <AlertFields config={config} onChange={setConfig} disabled={saving} settings={ws.data?.settings} />
          </Part>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="press h-9 rounded-sm border bg-background px-4 text-sm hover:border-foreground/50 disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={saving || !dirty} className="press flex h-9 items-center gap-2 rounded-sm bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {dirty ? "Save changes" : "No changes"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
