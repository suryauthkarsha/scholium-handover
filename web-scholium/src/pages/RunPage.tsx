// One research project: where it stands, the controls, and the panels that show what the models are doing.
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { toast } from "sonner";

import { Chip, Loading, Meter, StatusBadge, usd } from "@/components/bits";
import {
  MathText,
  Ref,
  RefProvider,
  type RefLookup,
} from "@/components/Markdown";
import Agents from "@/components/run/Agents";
import { Activity, Composer } from "@/components/run/Composer";
import {
  describe,
  RunProvider,
  useRunCtx,
  type RunCtx,
} from "@/components/run/ctx";
import Detail from "@/components/run/Detail";
import Evidence from "@/components/run/Evidence";
import Report from "@/components/run/Report";
import Research from "@/components/run/Research";
import Setup from "@/components/run/Setup";
import { Page } from "@/components/Shell";
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
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { goalProgress } from "@/engine/progress";
import { fmtDuration } from "@/engine/util";
import { useIsMobile } from "@/hooks/use-mobile";
import { api, errorText, type RunAction } from "@/lib/api";
import { useRun } from "@/lib/runStore";
import { LABEL_NAMES, PHASE_NAMES, SUBAGENT_HARD_CAP } from "@/shared/types";

const TABS = [
  { id: "research", label: "Research" },
  { id: "agents", label: "Agents" },
  { id: "evidence", label: "Evidence" },
  { id: "report", label: "Report" },
  { id: "live", label: "Live" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const BTN =
  "press flex h-8 shrink-0 items-center gap-1.5 rounded-sm border bg-background px-2.5 text-[0.82rem] hover:border-foreground/50 disabled:opacity-50";
const MAIN_BTN =
  "press flex h-8 shrink-0 items-center gap-1.5 rounded-sm bg-primary px-3 text-[0.82rem] font-medium text-primary-foreground disabled:opacity-50";

function Gauge({
  label,
  value,
  limit,
  n,
  max,
  mark,
  tone,
  title,
}: {
  label: string;
  value: string;
  limit: string;
  n: number;
  max: number;
  mark?: number;
  tone?: "ink" | "rubric";
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="eyebrow">{label}</dt>
      <dd className="tabular mb-1 truncate text-sm">
        <span className="font-medium">{value}</span>
        <span className="text-muted-foreground"> / {limit}</span>
      </dd>
      <Meter value={n} max={max} mark={mark} tone={tone} />
    </div>
  );
}

/** How far the best recorded answer is toward the goal. Counted from the ledger; never an estimate of time left. */
function GoalBar() {
  const { run, data } = useRunCtx();
  const p = useMemo(() => goalProgress(run, data), [run, data]);
  const total = p.steps.length;
  const next = p.steps[p.done];
  const state = p.reached
    ? "Goal reached"
    : p.done === 0
      ? "No standing answer yet"
      : `Step ${p.done} of ${total}`;
  const first = p.missing[0];
  return (
    <div className="mt-3">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
        <span className="eyebrow">Progress toward the goal</span>
        <span className={`tabular font-medium ${p.reached ? "text-ok" : ""}`}>
          {state}
        </span>
        {p.claimId && p.label && (
          <span className="min-w-0 text-muted-foreground">
            <Ref id={p.claimId} /> stands as “{LABEL_NAMES[p.label]}”
          </span>
        )}
        <span
          className="ml-auto hidden text-xs text-muted-foreground sm:inline"
          title="Each step is a level of evidence the best answer to the goal has reached in the ledger, up to the standard this project requires, plus the final confirmation. It is a count of recorded facts, not a forecast of time or cost, and it goes down if an answer is refuted."
        >
          counted from the ledger, not a forecast
        </span>
      </div>
      <div
        className="flex gap-1"
        role="progressbar"
        aria-label="Progress toward the goal"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={p.done}
        aria-valuetext={`${state}${next ? `. Next: ${next}` : ""}`}
      >
        {p.steps.map((name, i) => (
          <div
            key={name}
            className="min-w-0 flex-1"
            title={`${name}: ${i < p.done ? "done" : i === p.done ? "next" : "not yet"}`}
          >
            <div
              className={`h-1.5 rounded-full transition-colors duration-500 ${i < p.done ? (p.reached ? "bg-ok" : "bg-rubric") : i === p.done && run.status === "running" ? "seg-next" : "bg-secondary"}`}
            />
            <div
              className={`mt-1 hidden truncate text-[0.68rem] leading-tight md:block ${i < p.done ? "text-foreground/80" : i === p.done ? "text-foreground" : "text-muted-foreground/70"}`}
            >
              {name}
            </div>
          </div>
        ))}
      </div>
      {!p.reached && (
        <p
          className="mt-1 truncate text-xs text-muted-foreground"
          title={p.missing.join("\n")}
        >
          {next && <span className="md:hidden">Next: {next}. </span>}
          {first && <>Still missing: {first}</>}
          {p.missing.length > 1 && <> (+{p.missing.length - 1} more)</>}
        </p>
      )}
    </div>
  );
}

/** Whether the figures on screen are arriving live, and a way to fetch them again when they are not. */
function LinkState() {
  const { view, store } = useRunCtx();
  if (view.link === "live") {
    return (
      <span
        className="flex items-center gap-1.5 normal-case tracking-normal"
        title="Updates arrive as the server records them."
      >
        <span className="live-dot" /> live
      </span>
    );
  }
  const waiting = view.link === "connecting";
  return (
    <span
      className="flex items-center gap-1.5 normal-case tracking-normal text-warn"
      title={view.linkNote}
    >
      {waiting
        ? "connecting…"
        : view.link === "reconnecting"
          ? "reconnecting — figures are as last received"
          : "not connected — figures are as last received"}
      {!waiting && (
        <button
          type="button"
          onClick={() => void store.resync()}
          className="press flex items-center gap-1 rounded-sm border bg-background px-1.5 py-0.5 text-foreground hover:border-foreground/50"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      )}
    </span>
  );
}

const DID_NOT: Record<RunAction, string> = {
  start: "The run did not start",
  pause: "The run did not pause",
  resume: "The run did not continue",
  stop: "The run did not stop",
};

function Head({ onSetup }: { onSetup: () => void }) {
  const { id, run, view, store } = useRunCtx();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<RunAction | "delete" | null>(null);
  const [ask, setAsk] = useState<"stop" | "delete" | null>(null);

  const act = async (kind: RunAction): Promise<void> => {
    setBusy(kind);
    try {
      await api.action(id, kind);
      if (view.link !== "live") void store.resync();
    } catch (e) {
      toast.error(DID_NOT[kind], {
        description: errorText(e),
        duration: 12_000,
      });
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    }
  };

  const remove = async (): Promise<void> => {
    setBusy("delete");
    try {
      await api.deleteRun(id);
      void queryClient.invalidateQueries({ queryKey: ["workspace"] });
      navigate("/");
    } catch (e) {
      toast.error("The project was not deleted", {
        description: errorText(e),
        duration: 12_000,
      });
      setBusy(null);
    }
  };

  const s = run.status;
  const title = run.config.title || "Untitled project";
  const cap = Math.min(run.config.limits.subagentCap, SUBAGENT_HARD_CAP);
  const untilSpend = run.config.limits.untilSpend === true;
  const spin = (k: RunAction | "delete", icon: ReactNode): ReactNode =>
    busy === k ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon;
  const off = busy !== null;

  return (
    <header className="sheet-head no-print relative z-[1] shrink-0 border-b px-4 py-3 md:px-5">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="eyebrow flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="rubric">{PHASE_NAMES[run.phase]}</span>
            {run.cycle > 0 && <span>cycle {run.cycle}</span>}
            <LinkState />
          </div>
          <h1
            className="mt-1 truncate font-serif text-[1.45rem] leading-tight"
            title={title}
          >
            <MathText text={title} />
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={s} />
          {s === "draft" && (
            <button
              type="button"
              className={MAIN_BTN}
              disabled={off}
              onClick={() => void act("start")}
            >
              {spin("start", <Play className="h-3.5 w-3.5" />)} Start
            </button>
          )}
          {s === "running" && (
            <button
              type="button"
              className={BTN}
              disabled={off}
              onClick={() => void act("pause")}
            >
              {spin("pause", <Pause className="h-3.5 w-3.5" />)} Pause
            </button>
          )}
          {s !== "draft" && s !== "running" && (
            <button
              type="button"
              className={MAIN_BTN}
              disabled={off}
              onClick={() => void act("resume")}
            >
              {spin("resume", <Play className="h-3.5 w-3.5" />)}{" "}
              {s === "stopped" || s === "completed" ? "Continue" : "Resume"}
            </button>
          )}
          {s !== "draft" && s !== "stopped" && s !== "completed" && (
            <button
              type="button"
              className={BTN}
              disabled={off}
              onClick={() => setAsk("stop")}
            >
              {spin("stop", <Square className="h-3.5 w-3.5" />)} Stop
            </button>
          )}
          <button
            type="button"
            className={BTN}
            onClick={onSetup}
            aria-label="Project setup"
            title="Project setup"
          >
            <Settings2 className="h-3.5 w-3.5" />{" "}
            <span className="hidden sm:inline">Setup</span>
          </button>
          <button
            type="button"
            className={BTN}
            disabled={off}
            onClick={() => setAsk("delete")}
            aria-label="Delete this project"
            title="Delete this project"
          >
            {spin("delete", <Trash2 className="h-3.5 w-3.5" />)}
          </button>
        </div>
      </div>

      {s !== "draft" && <GoalBar />}

      <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2.5 sm:grid-cols-4">
        <Gauge
          label="Model spend"
          value={usd(run.spend.usd)}
          limit={usd(run.config.limits.spendUsd)}
          n={run.spend.usd}
          mark={run.spend.usd + run.spend.reservedUsd}
          max={run.config.limits.spendUsd}
          tone="rubric"
          title={`${run.spend.calls.toLocaleString()} model calls so far. ${usd(run.spend.reservedUsd)} more is set aside for calls under way.`}
        />
        <Gauge
          label="Active time"
          value={fmtDuration(run.activeMs)}
          limit={
            untilSpend
              ? "no limit"
              : fmtDuration(run.config.limits.runtimeMin * 60_000)
          }
          n={untilSpend ? 0 : run.activeMs}
          max={run.config.limits.runtimeMin * 60_000}
          title={`Time the run has spent working, as last reported by the server. Pauses do not count.${untilSpend ? " This run continues until its spending limit is reached." : ""}`}
        />
        <Gauge
          label="Sub-agents"
          value={String(run.subagents.created)}
          limit={String(cap)}
          n={run.subagents.created}
          max={cap}
          title={`${run.subagents.running} working, ${run.subagents.queued} waiting, ${run.subagents.completed} finished, ${run.subagents.failed} failed. A run never creates more than ${SUBAGENT_HARD_CAP}.`}
        />
        <Gauge
          label="Cycle"
          value={String(run.cycle)}
          limit={untilSpend ? "no limit" : String(run.config.limits.maxCycles)}
          n={untilSpend ? 0 : run.cycle}
          max={run.config.limits.maxCycles}
          title={
            untilSpend
              ? "This run continues until its spending limit is reached."
              : undefined
          }
        />
      </dl>

      <AlertDialog open={ask !== null} onOpenChange={(o) => !o && setAsk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-xl font-medium">
              {ask === "delete" ? "Delete this project?" : "Stop this run?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {ask === "delete"
                ? "Its claims, transcripts, files and checkpoints are removed from Scholium for good. Copies already uploaded to Google Drive are not touched."
                : "The run ends here. Everything recorded so far is kept and a checkpoint is saved. Pause instead if you only want it to wait."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={
                ask === "delete"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              onClick={() => {
                const what = ask;
                setAsk(null);
                if (what === "delete") void remove();
                else if (what === "stop") void act("stop");
              }}
            >
              {ask === "delete" ? "Delete" : "Stop the run"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  );
}

const EDGE = {
  bad: "border-destructive",
  warn: "border-warn",
  ok: "border-ok",
  muted: "border-rule",
} as const;

/** Things the server has said about the run as a whole: why it is waiting, what failed, how it ended. */
function Notices() {
  const { run, view } = useRunCtx();
  const items: { key: string; tone: keyof typeof EDGE; body: ReactNode }[] = [];
  if (run.status === "draft")
    items.push({
      key: "draft",
      tone: "muted",
      body: "Not started. Nothing runs and nothing is spent until you press Start.",
    });
  if (run.error) items.push({ key: "error", tone: "bad", body: run.error });
  if (run.pauseReason && run.status !== "running")
    items.push({ key: "pause", tone: "warn", body: run.pauseReason });
  if (run.goalReached) {
    items.push({
      key: "goal",
      tone: "ok",
      body: (
        <>
          The run reports the goal as reached
          {run.goalClaimId ? (
            <>
              {" "}
              by claim <Ref id={run.goalClaimId} />
            </>
          ) : null}
          . Read its label and any objection before relying on it.
        </>
      ),
    });
  }
  if (run.outcome)
    items.push({ key: "outcome", tone: "muted", body: run.outcome });
  for (const [tool, st] of Object.entries(run.toolStatus))
    if (!st.ok)
      items.push({
        key: `tool-${tool}`,
        tone: "warn",
        body: `${tool} is not available to this run: ${st.detail}`,
      });
  if (run.driveError)
    items.push({
      key: "drive",
      tone: "warn",
      body: `Google Drive: ${run.driveError}`,
    });
  if (run.branchedFrom) {
    items.push({
      key: "branch",
      tone: "muted",
      body: (
        <>
          Branched from checkpoint {run.branchedFrom.checkpointId} of{" "}
          <Link
            to={`/r/${run.branchedFrom.runId}`}
            className="underline underline-offset-4"
          >
            another project
          </Link>
          .
        </>
      ),
    });
  }
  if (view.linkNote && view.link !== "live")
    items.push({ key: "link", tone: "warn", body: view.linkNote });
  if (!items.length) return null;
  return (
    <div className="no-print max-h-32 shrink-0 space-y-1.5 overflow-y-auto border-b px-4 py-2.5 text-[0.84rem] md:px-5">
      {items.map((n) => (
        <p
          key={n.key}
          className={`break-words border-l-2 pl-2.5 ${EDGE[n.tone]}`}
        >
          {n.body}
        </p>
      ))}
    </div>
  );
}

function Body({ tab }: { tab: Tab }) {
  if (tab === "agents") return <Agents />;
  if (tab === "evidence") return <Evidence />;
  if (tab === "report") return <Report />;
  return <Research />;
}

function Live() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <Activity />
      <Composer />
    </div>
  );
}

function Panels() {
  const { run } = useRunCtx();
  const mobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const wanted = TABS.find((t) => t.id === params.get("tab"))?.id ?? "research";
  const tab: Tab = !mobile && wanted === "live" ? "research" : wanted;
  const go = (t: Tab): void =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (t === "research") next.delete("tab");
        else next.set("tab", t);
        return next;
      },
      { replace: true },
    );

  const main = (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Views of this project"
        className="no-print flex shrink-0 gap-1 overflow-x-auto border-b px-3 md:px-4"
      >
        {TABS.filter((t) => mobile || t.id !== "live").map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => go(t.id)}
            className={`press -mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2.5 text-[0.88rem] ${tab === t.id ? "border-rubric font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
            {t.id === "agents" && run.subagents.running > 0 && (
              <Chip tone="live">{run.subagents.running}</Chip>
            )}
          </button>
        ))}
      </div>
      {tab === "live" ? (
        <Live />
      ) : (
        <div className="relative min-h-0 flex-1">
          <div key={tab} role="tabpanel" className="h-full overflow-y-auto">
            <Body tab={tab} />
          </div>
          {mobile && (
            <button
              type="button"
              onClick={() => go("live")}
              className="no-print press absolute bottom-4 right-4 flex h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground shadow-lg"
            >
              <MessageSquare className="h-4 w-4" /> Message the leads
            </button>
          )}
        </div>
      )}
    </div>
  );

  if (mobile) return <div className="min-h-0 flex-1">{main}</div>;
  return (
    <ResizablePanelGroup
      direction="horizontal"
      autoSaveId="scholium-run"
      className="min-h-0 flex-1"
    >
      <ResizablePanel defaultSize={64} minSize={36}>
        {main}
      </ResizablePanel>
      <ResizableHandle withHandle className="no-print" />
      <ResizablePanel
        defaultSize={36}
        minSize={22}
        maxSize={58}
        className="no-print"
      >
        <Live />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export default function RunPage() {
  const { id = "" } = useParams();
  const { view, store } = useRun(id);
  const [stack, setStack] = useState<string[]>([]);
  const [setup, setSetup] = useState(false);

  const open = useCallback(
    (ref: string) =>
      setStack((s) => (s[s.length - 1] === ref ? s : [...s.slice(-40), ref])),
    [],
  );
  const refs = useMemo<RefLookup>(
    () => ({ open, describe: (ref) => describe(view.data, ref) }),
    [open, view.data],
  );
  const ctx = useMemo<RunCtx | null>(
    () =>
      view.run
        ? { id, view, store, data: view.data, run: view.run, open }
        : null,
    [id, view, store, open],
  );

  if (view.fatal) {
    return (
      <Page eyebrow="Project" title="This project cannot be shown">
        <p className="text-muted-foreground">
          {view.fatal}{" "}
          <Link to="/" className="text-rubric underline underline-offset-4">
            Back to the projects
          </Link>
        </p>
      </Page>
    );
  }
  if (!ctx) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loading what="Opening the project" />
      </div>
    );
  }

  return (
    <RunProvider value={ctx}>
      <RefProvider value={refs}>
        <div className="flex h-full min-h-0 flex-col">
          <Head onSetup={() => setSetup(true)} />
          <Notices />
          <Panels />
        </div>
        <Detail
          refId={stack[stack.length - 1] ?? null}
          onBack={
            stack.length > 1 ? () => setStack((s) => s.slice(0, -1)) : undefined
          }
          onClose={() => setStack([])}
        />
        {setup && <Setup onClose={() => setSetup(false)} />}
      </RefProvider>
    </RunProvider>
  );
}
