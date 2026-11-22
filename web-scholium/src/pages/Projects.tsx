// The list of research projects, with what each has cost and how far it has got.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, GitBranch, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import {
  Empty,
  ErrorNote,
  Loading,
  Meter,
  ModelTag,
  Section,
  StatusBadge,
  timeAgo,
  useCountUp,
  usd,
} from "@/components/bits";
import { MathText } from "@/components/Markdown";
import { Page, useWorkspace } from "@/components/Shell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, errorText } from "@/lib/api";
import { PHASE_NAMES, type RunSummary } from "@/shared/types";

function Figure({
  label,
  n,
  show,
  note,
  children,
}: {
  label: string;
  n: number;
  show: (n: number) => string;
  note?: string;
  children?: React.ReactNode;
}) {
  const shown = useCountUp(n);
  return (
    <div className="min-w-0">
      <p className="eyebrow">{label}</p>
      <p className="tabular mt-1 font-serif text-[1.95rem] leading-none">
        {show(shown)}
      </p>
      {children && <div className="mt-2">{children}</div>}
      {note && (
        <p className="mt-1.5 text-[0.8rem] leading-snug text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  );
}

function Row({
  run,
  onDelete,
}: {
  run: RunSummary;
  onDelete: (r: RunSummary) => void;
}) {
  return (
    <li className="leaf hairline group relative border-b">
      <Link
        to={`/r/${run.id}`}
        className="block bg-gradient-to-r from-transparent to-transparent py-4 pr-10 transition-colors hover:from-accent/60 sm:px-3"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="min-w-0 max-w-full truncate text-[1.32rem] font-normal leading-tight transition-transform duration-200 group-hover:translate-x-0.5">
            <MathText text={run.title || "Untitled project"} />
          </h3>
          <StatusBadge status={run.status} />
          {run.goalReached && (
            <span className="chip border-ok/35 bg-ok-soft text-ok">
              <Check className="h-3 w-3" /> Goal reached
            </span>
          )}
          {run.branchedFrom && (
            <span
              className="chip border-border bg-secondary text-muted-foreground"
              title="Branched from a checkpoint of another project"
            >
              <GitBranch className="h-3 w-3" /> Branch
            </span>
          )}
        </div>
        {run.goal && (
          <p className="mt-1 line-clamp-2 max-w-3xl font-serif text-[1.02rem] leading-snug text-muted-foreground">
            <MathText text={run.goal} />
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8rem] text-muted-foreground">
          <span className="flex items-center gap-3 text-foreground">
            {run.leads.map((m) => (
              <ModelTag key={m} model={m} />
            ))}
          </span>
          <span>
            {PHASE_NAMES[run.phase] ?? run.phase}
            {run.cycle > 0 ? ` · cycle ${run.cycle}` : ""}
          </span>
          <span className="tabular">{usd(run.spendUsd)} spent</span>
          <span>updated {timeAgo(run.updatedAt)}</span>
        </div>
      </Link>
      <button
        type="button"
        onClick={() => onDelete(run)}
        aria-label={`Delete ${run.title || "this project"}`}
        title="Delete this project"
        className="press absolute right-1 top-4 flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground opacity-60 transition-opacity hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}

export default function Projects() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const [doomed, setDoomed] = useState<RunSummary | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRun(id),
    onSuccess: () => {
      toast.success("The project and everything stored for it were deleted.");
      void qc.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: (e) => toast.error(errorText(e)),
    onSettled: () => setDoomed(null),
  });

  const data = ws.data;
  const runs = [...(data?.runs ?? [])].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const active = runs.filter((r) => r.status === "running").length;
  const b = data?.budget;
  const u = data?.usage;
  const busiest = u
    ? Math.max(
        u.written / u.allowance.written,
        u.read / u.allowance.read,
        u.calls / u.allowance.calls,
      )
    : 0;

  return (
    <Page
      eyebrow="Workspace"
      title="Projects"
      actions={
        <Link
          to="/new"
          className="press inline-flex h-10 items-center gap-1.5 rounded-sm bg-primary px-4 font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> New project
        </Link>
      }
    >
      {ws.isLoading && <Loading what="Loading the workspace" />}
      {ws.isError && !data && (
        <ErrorNote error={ws.error} retry={() => void ws.refetch()} />
      )}

      {data && b && u && (
        <>
          <div className="rise hairline mb-10 grid gap-6 border-y bg-gradient-to-r from-card/70 via-card/25 to-transparent py-5 sm:grid-cols-3 sm:px-3 sm:[&>*+*]:border-l sm:[&>*+*]:border-rule sm:[&>*+*]:pl-6">
            <Figure
              label={`Model spend, ${b.month}`}
              n={b.spentUsd}
              show={usd}
              note={`Ceiling ${usd(b.capUsd)}. ${usd(Math.max(0, b.committedUsd - b.spentUsd))} more is reserved by running projects.`}
            >
              <Meter
                value={b.spentUsd}
                mark={b.committedUsd}
                max={b.capUsd}
                tone={b.availableUsd <= 0 ? "rubric" : "ink"}
              />
            </Figure>
            <Figure
              label="Running now"
              n={active}
              show={(v) => String(Math.round(v))}
              note={
                active
                  ? "They keep working when this tab is closed or you sign out."
                  : "Nothing is running, so nothing is being spent."
              }
            />
            <Figure
              label="Free server allowance today"
              n={busiest}
              show={(v) => `${Math.round(v * 100)}%`}
              note={
                u.blocked ??
                `Runs pause themselves at ${Math.round(u.pauseAt * 100)}% so the free allowance is never exceeded.`
              }
            >
              <Meter
                value={busiest}
                max={1}
                tone={busiest >= u.pauseAt ? "rubric" : "ink"}
              />
            </Figure>
          </div>

          <Section
            title="All projects"
            aside={runs.length ? `${runs.length} in this workspace` : undefined}
          >
            {runs.length === 0 ? (
              <Empty
                title="No projects yet"
                action={
                  <Link
                    to="/new"
                    className="press inline-flex h-10 items-center gap-1.5 rounded-sm bg-primary px-4 font-medium text-primary-foreground"
                  >
                    <Plus className="h-4 w-4" /> Start the first one
                  </Link>
                }
              >
                State a problem, choose the lead models and set a spending
                limit. The models plan, compute, search and review on their own,
                and you can steer at any point.
              </Empty>
            ) : (
              <ul className="stagger -mt-3">
                {runs.map((r) => (
                  <Row key={r.id} run={r} onDelete={setDoomed} />
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      <AlertDialog open={!!doomed} onOpenChange={(o) => !o && setDoomed(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-2xl font-normal">
              Delete “{doomed?.title || "Untitled project"}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This stops the run if it is active and permanently deletes its
              claims, evidence, transcripts, uploads and checkpoints from the
              server. Files already saved to your Google Drive are not touched.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={() => doomed && remove.mutate(doomed.id)}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
