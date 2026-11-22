// The frame around every signed-in screen: the project sidebar, the month's spending, and the account.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, LogOut, Menu, Play, Plus, Settings2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { toast } from "sonner";

import { Meter, STATUS, usd } from "@/components/bits";
import { MathText } from "@/components/Markdown";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/useAuth";
import { api, errorText } from "@/lib/api";
import { ThemeToggle } from "@/lib/theme";
import { PHASE_NAMES, type RunSummary } from "@/shared/types";

export function useWorkspace() {
  return useQuery({
    queryKey: ["workspace"],
    queryFn: ({ signal }) => api.workspace(signal),
    refetchInterval: 20_000,
    staleTime: 5_000,
  });
}

const DOT: Record<string, string> = {
  muted: "bg-muted-foreground/45",
  live: "bg-rubric",
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-destructive",
};

function RunLink({
  run,
  onNavigate,
}: {
  run: RunSummary;
  onNavigate?: () => void;
}) {
  const s = STATUS[run.status] ?? STATUS.draft;
  return (
    <NavLink
      to={`/r/${run.id}`}
      onClick={onNavigate}
      className={({ isActive }) =>
        `group relative block rounded-sm py-2 pl-6 pr-2 transition-colors ${isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"}`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="mark-in absolute inset-y-1.5 left-0 w-[2px] bg-rubric" />
          )}
          <span
            className={`absolute left-2 top-[0.95rem] h-2 w-2 rounded-full ${run.status === "running" ? "live-dot" : DOT[s.tone]}`}
            title={s.label}
          />
          <span className="block truncate font-serif text-[1.02rem] leading-tight transition-transform duration-200 group-hover:translate-x-0.5">
            <MathText text={run.title || run.goal || "Untitled project"} />
          </span>
          <span className="mt-0.5 block truncate text-[0.74rem] text-muted-foreground">
            {s.label} · {PHASE_NAMES[run.phase] ?? run.phase}
            {run.cycle > 1 ? ` · cycle ${run.cycle}` : ""} · {usd(run.spendUsd)}
          </span>
        </>
      )}
    </NavLink>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { access, signOut } = useAuth();
  const ws = useWorkspace();
  const runs = [...(ws.data?.runs ?? [])].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const budget = ws.data?.budget;
  const usage = ws.data?.usage;
  const me = access.state === "allowed" ? access : null;

  return (
    <div className="paper gutter flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <Link
          to="/"
          onClick={onNavigate}
          className="group flex items-center gap-2.5"
        >
          <img
            src="/icon.png"
            alt=""
            className="h-7 w-7 rounded-[6px] shadow-[0_4px_10px_-4px_hsl(var(--shade)/0.5)] transition-transform duration-500 group-hover:-rotate-6 group-hover:scale-105"
          />
          <span className="font-serif text-[1.3rem] leading-none">
            Scholium
          </span>
        </Link>
        <ThemeToggle />
      </div>

      <div className="px-3">
        <Link
          to="/new"
          onClick={onNavigate}
          className="press flex h-9 items-center justify-center gap-1.5 rounded-sm bg-primary text-[0.93rem] font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> New project
        </Link>
      </div>

      <div className="mt-5 flex items-baseline justify-between px-4">
        <span className="rubric">Projects</span>
        <span className="tabular text-[0.74rem] text-muted-foreground">
          {ws.data ? runs.length : ""}
        </span>
      </div>
      <nav className="mt-1.5 min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3">
        {ws.isLoading && (
          <p className="px-2 py-3 text-[0.86rem] text-muted-foreground">
            Loading…
          </p>
        )}
        {ws.isError && !ws.data && (
          <p className="px-2 py-3 text-[0.86rem] text-destructive">
            The project list could not be loaded.
          </p>
        )}
        {ws.data && runs.length === 0 && (
          <p className="px-2 py-3 text-[0.86rem] leading-relaxed text-muted-foreground">
            No projects yet. Start one and it will stay here, with its whole
            record.
          </p>
        )}
        {runs.map((r) => (
          <RunLink key={r.id} run={r} onNavigate={onNavigate} />
        ))}
      </nav>

      {budget && (
        <Link
          to="/settings"
          onClick={onNavigate}
          className="sheet mx-3 mb-2 block rounded-sm border bg-card/60 p-2.5 transition-colors hover:bg-card"
        >
          <div className="flex items-baseline justify-between text-[0.74rem]">
            <span className="eyebrow">Model spend, {budget.month}</span>
            <span className="tabular">
              {usd(budget.spentUsd)}{" "}
              <span className="text-muted-foreground">
                of {usd(budget.capUsd)}
              </span>
            </span>
          </div>
          <div className="mt-1.5">
            <Meter
              value={budget.spentUsd}
              mark={budget.committedUsd}
              max={budget.capUsd}
              tone={budget.availableUsd <= 0 ? "rubric" : "ink"}
            />
          </div>
          {usage?.blocked && (
            <p className="mt-1.5 text-[0.74rem] leading-snug text-rubric">
              {usage.blocked}
            </p>
          )}
        </Link>
      )}

      <div className="hairline flex items-center gap-2 border-t px-3 py-2.5">
        {me?.picture ? (
          <img
            src={me.picture}
            alt=""
            referrerPolicy="no-referrer"
            className="h-7 w-7 rounded-full"
          />
        ) : (
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary font-serif">
            {(me?.email ?? "?").slice(0, 1).toUpperCase()}
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-[0.8rem]"
          title={me?.email}
        >
          {me?.email}
        </span>
        <Link
          to="/settings"
          onClick={onNavigate}
          aria-label="Settings"
          title="Settings"
          className="press flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
        >
          <Settings2 className="h-4 w-4" />
        </Link>
        <button
          type="button"
          onClick={signOut}
          aria-label="Sign out"
          title="Sign out"
          className="press flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Shown on every page while another copy of the site is the one working. One press moves the work here:
 * every project is read back from the permanent store, and those that were working or paused carry on.
 */
function Standby() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const v = ws.data?.vault;
  const r = v?.restore;
  const lining = v?.mode === "active" && !!r && r.done < r.total;
  // While projects are being read back, look again every few seconds so each appears as soon as it is in.
  useEffect(() => {
    if (!lining) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ["workspace"] }), 3000);
    return () => clearInterval(t);
  }, [lining, qc]);
  if (!v) return null;
  if (lining && r)
    return (
      <div className="no-print flex shrink-0 items-center gap-2 border-b bg-secondary px-4 py-2 text-sm" role="status">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span>
          Bringing your projects over from the permanent store: {r.done} of {r.total}. Each one carries on by itself as soon as it is here.
        </span>
      </div>
    );
  if (v.mode !== "standby") return null;
  const go = async (): Promise<void> => {
    setBusy(true);
    try {
      const out = await api.continueHere("vault", true);
      const n = out.resuming ?? 0;
      toast.success("The work now continues on this copy of the site.", {
        description: `Every project is being read back from the permanent store.${n ? ` ${n} paused project${n === 1 ? "" : "s"} will start working again as soon as ${n === 1 ? "it is" : "they are"} here.` : ""}`,
      });
    } catch (e) {
      toast.error(errorText(e));
    }
    setBusy(false);
    await qc.invalidateQueries({ queryKey: ["workspace"] });
  };
  return (
    <div className="no-print flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-secondary px-4 py-2 text-sm">
      <span className="min-w-0 flex-1 basis-64">
        Your work is saved under your email and is ready to carry on here. Right now the copy at{" "}
        <span className="font-medium">{v.holder || "another address"}</span> holds it; that copy stops when you continue here.
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void go()}
        className="press flex h-9 shrink-0 items-center gap-1.5 rounded-sm bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        Continue here
      </button>
    </div>
  );
}

export default function Shell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="no-print hidden w-[17.5rem] shrink-0 border-r border-sidebar-border md:block">
        <Sidebar />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label="Open the project list"
                className="press flex h-9 w-9 items-center justify-center rounded-sm border bg-card"
              >
                <Menu className="h-4 w-4" />
              </button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[19rem] p-0">
              <SheetTitle className="sr-only">Projects</SheetTitle>
              <Sidebar onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <Link to="/" className="font-serif text-lg">
            Scholium
          </Link>
        </header>
        <Standby />
        <main
          key={location.pathname.startsWith("/r/") ? location.pathname : "page"}
          className="print-root min-h-0 flex-1 overflow-hidden"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** A plain scrolling page with a heading, used by every screen except the run view. */
export function Page({
  eyebrow,
  title,
  actions,
  children,
  wide = false,
}: {
  eyebrow?: string;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div
        className={`mx-auto px-5 pb-20 pt-8 sm:px-10 sm:pt-12 ${wide ? "max-w-6xl" : "max-w-4xl"}`}
      >
        <div className="rise mb-8 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            {eyebrow && <p className="rubric mb-2">{eyebrow}</p>}
            <h1 className="initial text-[2.2rem] font-normal leading-[1.08] sm:text-[2.6rem]">
              {title}
            </h1>
            <span className="flourish" aria-hidden="true" />
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        <div className="rise" style={{ animationDelay: "90ms" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
