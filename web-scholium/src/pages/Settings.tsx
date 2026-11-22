// Workspace settings: the spending ceiling, the outside services, connection checks, method notes and the session.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, ExternalLink, Eye, EyeOff, KeyRound, Loader2, LogOut, ScanSearch, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Chip, ErrorNote, Loading, Meter, ModelTag, Section, timeAgo, usd } from "@/components/bits";
import { Field } from "@/components/ConfigForm";
import Methods from "@/components/Methods";
import { Page, useWorkspace } from "@/components/Shell";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/useAuth";
import { api, errorText, saveBlob, type SettingsPatch, type StoreTally } from "@/lib/api";
import { ThemeToggle } from "@/lib/theme";
import type { UsageView } from "@/shared/budget";
import { ALLOWED_EMAIL } from "@/shared/gate";
import { MODEL_KEYS, MODELS, type ModelKey } from "@/shared/models";
import type { DiagnosticResult, PublicSettings, RunSummary, VaultView, WorkspaceOverview } from "@/shared/types";

const BTN = "press flex h-9 shrink-0 items-center gap-1.5 rounded-sm border bg-background px-3 text-sm hover:border-foreground/50 disabled:opacity-50";
type Save = (patch: SettingsPatch, done: string) => Promise<boolean>;

function Item({ title, state, children }: { title: string; state?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-t py-5 first:border-t-0 first:pt-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{title}</h3>
        {state}
      </div>
      <div className="space-y-3 text-sm">{children}</div>
    </div>
  );
}

/** The permanent store: an exact copy of every project, kept outside the site, and which copy of the site is working. */
/** Room a free database plan gives, and the point at which it is worth acting. */
const FREE_ROOM = 500 * 1024 * 1024;
const ROOM_WARN = 0.8;

/** How much of the database the stored projects take. */
function StoreRoom() {
  const info = useQuery({ queryKey: ["vault-info"], queryFn: ({ signal }) => api.vaultInfo(signal), staleTime: 60_000, refetchInterval: 10 * 60_000 });
  const size = info.data?.bytes;
  if (typeof size !== "number") return null;
  const part = size / FREE_ROOM;
  // Past 500 MB the database is plainly on a larger plan, so the warning only applies below it.
  const near = part >= ROOM_WARN && part < 1;
  return (
    <div className="max-w-2xl space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          The stored projects take <span className="font-medium tabular-nums">{Math.max(1, Math.round(size / 1048576)).toLocaleString()} MB</span> of the database.
        </span>
        {near && <Chip tone="warn">Close to a free plan's room</Chip>}
      </div>
      {part < 1 && <Meter value={size} max={FREE_ROOM} mark={FREE_ROOM * ROOM_WARN} tone={near ? "rubric" : "ink"} />}
      <p className="text-xs text-muted-foreground">
        {part < 1 ? "The bar is the 500 MB a free Supabase plan holds; a paid plan holds 8 GB and more. " : ""}
        When the database is full, new changes wait on this site and are sent as soon as there is room, and the work itself goes on.
      </p>
    </div>
  );
}

export function Storage({ v, refresh }: { v: VaultView; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = async (source: "vault" | "local"): Promise<void> => {
    if (source === "local" && !window.confirm("Use what is on this copy of the site and save it over the stored workspace settings? Choose this only if this copy is the one with your real work.")) return;
    setBusy(true);
    try {
      await api.continueHere(source);
      toast.success("The work now continues on this copy of the site.", { description: source === "vault" ? "Each project is being read back from the store; large ones take a moment to appear." : undefined });
    } catch (e) {
      toast.error(errorText(e));
    }
    setBusy(false);
    refresh();
  };
  if (!v.on)
    return (
      <Item title="Permanent store" state={<Chip>Not set up</Chip>}>
        <p className="max-w-2xl text-muted-foreground">
          This copy of the site is not connected to a permanent store, so projects live only on the site itself. To carry on here from another copy of Scholium, add one secret named <span className="font-mono text-foreground">SCHOLIUM_MOVE_KEY</span>{" "}
          holding that copy's move key, publish again, and come back to this page. Backup files below still work.
        </p>
      </Item>
    );
  const r = v.restore;
  const lining = r && r.done < r.total;
  const state =
    v.mode === "standby" ? <Chip tone="warn">Standby</Chip> : v.error ? <Chip tone="bad">Not reaching the store</Chip> : v.mode !== "active" ? <Chip>Starting</Chip> : v.pending ? <Chip tone="warn">{v.pending} waiting</Chip> : <Chip tone="ok">All saved</Chip>;
  return (
    <Item title="Permanent store" state={state}>
      <p className="max-w-2xl text-muted-foreground">
        Every project is copied, change by change, into a database that is separate from this site: the whole ledger, every message of every agent, sources and their texts, uploaded files, checkpoints and the activity log. Another copy of
        Scholium connected to the same database can carry on from exactly where this one stopped.
      </p>
      {v.mode === "active" && (
        <p>
          {v.pending ? `${v.pending} change${v.pending === 1 ? " is" : "s are"} on the way to the store.` : "Everything on this copy is in the store."}
          {v.lastSavedAt ? ` Last saved ${timeAgo(v.lastSavedAt)}.` : ""}
        </p>
      )}
      {v.mode === "standby" && (
        <p>
          The copy at <span className="font-medium">{v.holder || "another address"}</span> is the one working. This copy changes nothing until you move the work here. Pause running projects there first, so nothing is in mid-step when it moves.
        </p>
      )}
      <StoreRoom />
      {v.error && <p className="text-destructive">{v.error} Changes are kept here and sent as soon as the store answers.</p>}
      {r && (lining || r.failed > 0) && (
        <p>
          {lining ? `Lining up projects with the store: ${r.done} of ${r.total}.` : ""}
          {r.failed ? ` ${r.failed} could not be lined up yet.` : ""}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {v.mode === "standby" ? (
          <>
            <button type="button" className={BTN} disabled={busy} onClick={() => void go("vault")}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Continue here from the store, leaving paused projects paused
            </button>
            <button type="button" className={BTN} disabled={busy} onClick={() => void go("local")}>
              Continue here with what is on this copy
            </button>
          </>
        ) : (
          r &&
          r.failed > 0 &&
          !lining && (
            <button type="button" className={BTN} disabled={busy} onClick={() => void go("vault")}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Try again
            </button>
          )
        )}
      </div>
    </Item>
  );
}

const STORE_NAMES: Record<string, string> = {
  ws: "Settings, project list, budgets, Drive connection",
  "ent:run": "Project record and its settings",
  "ent:agent": "Agents: objective, state, findings",
  "ent:task": "Tasks: what each agent was doing",
  msg: "Agent messages, every word",
  "ent:call": "Model calls",
  "ent:experiment": "Experiments",
  "ent:claim": "Claims",
  "ent:evidence": "Evidence",
  "ent:note": "Notes",
  "ent:objection": "Objections",
  "ent:source": "Sources",
  txt: "Texts of sources and files",
  "ent:upload": "Uploaded files",
  blob: "Uploaded file contents",
  "ent:drivefile": "Files saved to Google Drive",
  "ent:artifact": "Written results",
  "ent:instruction": "Your instructions",
  "ent:review": "Reviews",
  "ent:email": "Emails sent",
  "ent:checkpoint": "Checkpoints",
  ev: "Activity log",
  kv: "Bookkeeping",
};
const storeName = (g: string): string => STORE_NAMES[g] ?? (g.startsWith("ent:") ? g.slice(4, 5).toUpperCase() + g.slice(5) : g);
const STORE_ORDER = Object.keys(STORE_NAMES);
const mb = (n: number): string => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(n >= 104_857_600 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

interface CheckLine extends StoreTally {
  group: string;
  here: number;
}
interface CheckReport {
  id: string;
  title: string;
  lines: CheckLine[];
  pending: number;
  error?: string;
}

function lineNote(l: CheckLine): { tone: "ok" | "warn" | "bad"; text: string } {
  // What is here but was not found in the store, beyond what is known to be on its way.
  const missing = Math.max(0, l.here - (l.store - l.extra) - l.moving);
  if (l.differ) return { tone: "bad", text: `${l.differ} differ` };
  const notes: string[] = [];
  if (l.moving) notes.push(`${l.moving} on the way`);
  if (missing) notes.push(`${missing} not in the store yet`);
  if (l.extra) notes.push(l.group === "ev" ? `${l.extra} older entries kept only in the store` : `${l.extra} only in the store`);
  if (!notes.length) return { tone: "ok", text: "Identical" };
  return { tone: l.moving || missing ? "warn" : "ok", text: notes.join(", ") };
}

/** Compares the store with this copy of the site, item by item, and shows the counts. */
function StoreCheck({ runs }: { runs: RunSummary[] }) {
  const [busy, setBusy] = useState("");
  const [reports, setReports] = useState<CheckReport[] | null>(null);
  const [at, setAt] = useState(0);
  const stop = useRef(false);
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );

  const one = async (id: string, title: string): Promise<CheckReport> => {
    const groups: Record<string, StoreTally> = {};
    let here: Record<string, number> = {};
    let pending = 0;
    let cursor: { tbl: string; k: string } | undefined;
    try {
      for (let step = 0; step < 5000 && !stop.current; step++) {
        const c = await api.checkStore(id || undefined, cursor);
        for (const [g, t] of Object.entries(c.groups)) {
          const sum = (groups[g] ??= { store: 0, same: 0, differ: 0, extra: 0, moving: 0 });
          sum.store += t.store;
          sum.same += t.same;
          sum.differ += t.differ;
          sum.extra += t.extra;
          sum.moving += t.moving;
        }
        if (c.here) here = c.here;
        if (typeof c.pending === "number") pending = c.pending;
        const seen = Object.values(groups).reduce((n, t) => n + t.store, 0);
        setBusy(`${title}: ${seen.toLocaleString()} items compared`);
        if (c.done || !c.cursor) break;
        cursor = c.cursor;
      }
    } catch (e) {
      return { id, title, lines: [], pending, error: errorText(e) };
    }
    const names = [...new Set([...Object.keys(groups), ...Object.keys(here)])].filter((g) => (groups[g]?.store ?? 0) + (here[g] ?? 0) > 0);
    names.sort((a, b) => (STORE_ORDER.indexOf(a) + 1 || 99) - (STORE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
    return { id, title, pending, lines: names.map((g) => ({ group: g, here: here[g] ?? 0, ...(groups[g] ?? { store: 0, same: 0, differ: 0, extra: 0, moving: 0 }) })) };
  };

  const run = async (): Promise<void> => {
    setBusy("Starting");
    const out: CheckReport[] = [await one("", "Workspace")];
    setReports([...out]);
    for (const r of runs) {
      if (stop.current) break;
      out.push(await one(r.id, r.title || "Untitled project"));
      setReports([...out]);
    }
    setAt(Date.now());
    setBusy("");
  };

  const all = (reports ?? []).flatMap((r) => r.lines);
  const differ = all.reduce((n, l) => n + l.differ, 0);
  const waiting = all.reduce((n, l) => n + l.moving + Math.max(0, l.here - (l.store - l.extra) - l.moving), 0);
  const failed = (reports ?? []).filter((r) => r.error).length;
  const total = all.reduce((n, l) => n + l.store, 0);
  const state = !reports || busy ? undefined : failed || differ ? <Chip tone="bad">{failed ? "Could not finish" : `${differ} differ`}</Chip> : waiting ? <Chip tone="warn">{waiting} still on the way</Chip> : <Chip tone="ok">Nothing missing</Chip>;

  return (
    <Item title="Check the store against this site" state={state}>
      <p className="max-w-2xl text-muted-foreground">
        Reads back everything the store holds and compares it with what is here, item by item and character for character: every agent, what it was doing, its messages, findings, sources, uploads and Drive files. Nothing is changed. A long project
        takes a minute or two.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={BTN} disabled={!!busy} onClick={() => void run()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />} {reports ? "Check again" : "Check now"}
        </button>
        {busy ? <span className="text-muted-foreground tabular-nums">{busy}</span> : at ? <span className="text-muted-foreground">Checked {timeAgo(at)}: {total.toLocaleString()} stored items read back.</span> : null}
      </div>
      {reports?.map((r) => (
        <div key={r.id || "ws"} className="overflow-x-auto rounded-sm border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
            <span className="font-medium">{r.title}</span>
            {r.error ? <span className="text-destructive">{r.error}</span> : r.pending ? <span className="text-muted-foreground">{r.pending} change{r.pending === 1 ? "" : "s"} on the way right now</span> : null}
          </div>
          {r.lines.length > 0 && (
            <table className="w-full min-w-[30rem] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-normal">What</th>
                  <th className="px-3 py-1.5 text-right font-normal">On this site</th>
                  <th className="px-3 py-1.5 text-right font-normal">In the store</th>
                  <th className="px-3 py-1.5 text-right font-normal">Identical</th>
                  <th className="px-3 py-1.5 font-normal">Result</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => {
                  const n = lineNote(l);
                  return (
                    <tr key={l.group} className="border-t">
                      <td className="px-3 py-1.5">{storeName(l.group)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{l.here.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{l.store.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{l.same.toLocaleString()}</td>
                      <td className={`px-3 py-1.5 ${n.tone === "bad" ? "text-destructive" : n.tone === "warn" ? "text-muted-foreground" : ""}`}>
                        {n.tone === "ok" && <Check className="mr-1 inline h-3.5 w-3.5" />}
                        {n.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ))}
      {reports && !busy && waiting > 0 && !differ && <p className="max-w-2xl text-muted-foreground">Items "on the way" changed in the last few seconds while a project was working. Pause the projects and check again to see every line identical.</p>}
    </Item>
  );
}

/** Everything needed to carry on from the store on a fresh copy of the site, on any Rork account. */
function MoveKit({ email }: { email: string }) {
  const info = useQuery({ queryKey: ["vault-info"], queryFn: ({ signal }) => api.vaultInfo(signal), staleTime: 60_000 });
  const [key, setKey] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState("");
  const fetchKey = async (): Promise<string> => {
    if (key) return key;
    const k = (await api.moveKey()).key;
    setKey(k);
    return k;
  };
  const act = async (what: "show" | "copy" | "code"): Promise<void> => {
    setBusy(what);
    try {
      if (what === "code") await api.downloadCode();
      else if (what === "show") {
        await fetchKey();
        setShown(true);
      } else {
        await navigator.clipboard.writeText(await fetchKey());
        toast.success("Move key copied.", { description: "Paste it only into the new site's secrets." });
      }
    } catch (e) {
      toast.error(errorText(e));
    }
    setBusy("");
  };
  const code = info.data?.code;
  const size = info.data?.bytes;
  return (
    <Item title="Move to another Rork account" state={info.data?.moveKey ? <Chip tone="ok">Running on a move key</Chip> : undefined}>
      <p className="max-w-2xl text-muted-foreground">
        The work belongs to {email}, not to a Rork account. A fresh copy of this site on any account carries on from exactly where this one stopped, with one pasted value: the move key. It tells the new copy where the store is and lets it open the
        saved Google Drive connection, so files keep going to the same Drive folders.
      </p>
      <ol className="max-w-2xl list-decimal space-y-1 pl-5">
        <li>Pause the running projects here, and wait until the store shows "All saved".</li>
        <li>On the new account, give Rork the site's code (download below) and ask it to publish it unchanged.</li>
        <li>
          Add one secret there named <span className="font-mono">SCHOLIUM_MOVE_KEY</span> and paste the move key as its value.
        </li>
        <li>Open the new site, sign in as {email} and press "Continue here" in the bar at the top. Every project comes back, and those that were working or paused carry on.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BTN} disabled={!!busy} onClick={() => void act("copy")}>
          {busy === "copy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />} Copy the move key
        </button>
        <button type="button" className={BTN} disabled={!!busy} onClick={() => (shown ? setShown(false) : void act("show"))}>
          {busy === "show" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {shown ? "Hide it" : "Show it"}
        </button>
        <button type="button" className={BTN} disabled={!!busy || !code} onClick={() => void act("code")}>
          {busy === "code" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Download the site's code
        </button>
      </div>
      {shown && key && <textarea readOnly value={key} rows={5} onFocus={(e) => e.currentTarget.select()} className="w-full max-w-2xl resize-none rounded-sm border bg-muted/40 p-2 font-mono text-xs break-all" aria-label="Move key" />}
      <p className="flex max-w-2xl items-start gap-2 text-muted-foreground">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Treat the move key like a password: whoever holds it can read and change everything in the store. Never paste it into a chat or a document.</span>
      </p>
      <p className="max-w-2xl text-muted-foreground">
        {code ? `The store holds a copy of the site's code: ${code.files.toLocaleString()} files, ${mb(code.bytes)}, saved ${timeAgo(Date.parse(code.at))}.` : info.isLoading ? "Looking in the store…" : "No copy of the site's code is in the store yet."}
        {typeof size === "number" ? ` The stored projects take ${mb(size)} of the database so far.` : ""}
      </p>
    </Item>
  );
}

function Spending({ d, save, busy }: { d: WorkspaceOverview; save: Save; busy: boolean }) {
  const b = d.budget;
  const [cap, setCap] = useState(String(b.capUsd));
  const n = Number(cap);
  return (
    <div className="space-y-4 text-sm">
      <Meter value={b.spentUsd} mark={b.committedUsd} max={b.capUsd} tone="rubric" />
      <p>
        <span className="tabular font-medium">{usd(b.spentUsd)}</span> spent on model calls in {b.month}, <span className="tabular">{usd(Math.max(0, b.committedUsd - b.spentUsd))}</span> more set aside for projects that are running, <span className="tabular">{usd(Math.max(0, b.availableUsd))}</span> free
        under the ceiling. Connection checks and method tests account for {usd(b.diagUsd)} of the spend.
      </p>
      <div className="flex max-w-md items-end gap-2">
        <Field label="Monthly ceiling (USD)">
          <Input aria-label="Monthly ceiling in dollars" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
        </Field>
        <button type="button" className={BTN} disabled={busy || !Number.isFinite(n) || n < 0 || n === b.capUsd} onClick={() => void save({ monthlyCapUsd: n }, "Ceiling saved")}>
          Save
        </button>
      </div>
      <p className="max-w-2xl text-muted-foreground">
        A run cannot start or continue once it would take the month past this ceiling. Model calls are paid from the credits already included in your Rork plan. Scholium cannot buy credits, change the plan or switch on billing; this ceiling is its own stop.
      </p>
    </div>
  );
}

function Allowance({ u }: { u: UsageView }) {
  const rows: [string, number, number][] = [
    ["Records written", u.written, u.allowance.written],
    ["Records read", u.read, u.allowance.read],
    ["Requests", u.calls, u.allowance.calls],
  ];
  return (
    <div className="space-y-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-3">
        {rows.map(([label, n, max]) => (
          <div key={label}>
            <p className="eyebrow">{label}</p>
            <p className="tabular mb-1">
              {n.toLocaleString()} <span className="text-muted-foreground">/ {max.toLocaleString()}</span>
            </p>
            <Meter value={n} max={max} />
          </div>
        ))}
      </div>
      {u.blocked && <p className="gloss">{u.blocked}</p>}
      <p className="max-w-2xl text-muted-foreground">
        The server's storage has a free daily allowance ({u.day}, UTC). Runs are paused at {Math.round(u.pauseAt * 100)}% of it and can be resumed the next day. The allowance is a limit, not a bill: past it the server refuses work until the next day. Today: {u.takes.email} of {u.takes.caps.email} emails, {u.takes.drive} of{" "}
        {u.takes.caps.drive} Drive uploads.
      </p>
    </div>
  );
}

function Exa({ s, save, busy }: { s: PublicSettings; save: Save; busy: boolean }) {
  const [key, setKey] = useState("");
  const [cap, setCap] = useState(String(s.exaMonthlyCap ?? 200));
  const n = Number(cap);
  const ready = s.exaKeySet && !!s.exaFreeConfirmed;
  return (
    <Item title="Exa search" state={s.exaEnabled && ready ? <Chip tone="ok">on</Chip> : <Chip>off</Chip>}>
      <p className="max-w-2xl text-muted-foreground">Optional. Off unless you add your own key, confirm the key is on Exa's free plan, and switch it on. Scholium counts every request and stops at the monthly number below, so a free allowance is not overrun.</p>
      <div className="flex max-w-xl items-end gap-2">
        <Field label={s.exaKeySet ? `Key saved (${s.exaKeyHint ?? "hidden"}). Paste a new one to replace it` : "Exa API key"}>
          <Input aria-label="Exa API key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <button type="button" className={BTN} disabled={busy || key.trim().length < 8} onClick={() => void save({ exaKey: key.trim() }, "Key saved").then((ok) => ok && setKey(""))}>
          Save
        </button>
        {s.exaKeySet && (
          <button type="button" className={BTN} disabled={busy} onClick={() => void save({ exaKey: null }, "Key removed")}>
            Remove
          </button>
        )}
      </div>
      <label className="flex items-center gap-3">
        <Switch checked={!!s.exaFreeConfirmed} disabled={busy || !s.exaKeySet} onCheckedChange={(v) => void save({ exaFreeConfirmed: v }, v ? "Confirmed" : "Confirmation removed")} />
        <span>I have checked that this key is on Exa's free plan, with no card that could be charged.</span>
      </label>
      <label className="flex items-center gap-3">
        <Switch checked={!!s.exaEnabled} disabled={busy || !ready} onCheckedChange={(v) => void save({ exaEnabled: v }, v ? "Exa is on" : "Exa is off")} />
        <span>Let runs use Exa.</span>
      </label>
      <div className="flex max-w-xs items-end gap-2">
        <Field label={`Requests per month (${s.exaUsedThisMonth ?? 0} used)`}>
          <Input aria-label="Exa requests per month" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} />
        </Field>
        <button type="button" className={BTN} disabled={busy || !Number.isInteger(n) || n < 0 || n === (s.exaMonthlyCap ?? 200)} onClick={() => void save({ exaMonthlyCap: n }, "Number saved")}>
          Save
        </button>
      </div>
    </Item>
  );
}

function Lean({ s, save, busy }: { s: PublicSettings; save: Save; busy: boolean }) {
  const [url, setUrl] = useState(s.leanUrl);
  return (
    <Item title="Lean 4 server" state={s.leanUrl ? <Chip tone="ok">address saved</Chip> : <Chip tone="warn">not set</Chip>}>
      <p className="max-w-2xl text-muted-foreground">The address of a Lean 4 server with Mathlib that speaks the lean4web protocol. Without one, nothing can be checked formally and no claim is ever labelled formally verified.</p>
      <div className="flex max-w-xl items-end gap-2">
        <Field label="Server address">
          <Input aria-label="Lean server address" type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <button type="button" className={BTN} disabled={busy || url.trim() === s.leanUrl} onClick={() => void save({ leanUrl: url.trim() }, url.trim() ? "Address saved" : "Address removed")}>
          Save
        </button>
      </div>
    </Item>
  );
}

function Connections({ s, refresh }: { s: PublicSettings; refresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const wrap = async (what: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast.error("Not done", { description: errorText(e), duration: 12_000 });
    } finally {
      setBusy(null);
      refresh();
    }
  };
  // Google's approval happens in another tab, on the backend's own address, which cannot report back to this page.
  // So while an attempt is open this page asks the server every few seconds whether Drive is connected yet.
  const [waitUntil, setWaitUntil] = useState(0);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!waitUntil || s.drive.connected) return;
    const every = window.setInterval(() => {
      if (Date.now() > waitUntil) setWaitUntil(0);
      else refreshRef.current();
    }, 4000);
    return () => window.clearInterval(every);
  }, [waitUntil, s.drive.connected]);
  const copy = (): void => void navigator.clipboard.writeText(s.drive.redirectUri).then(() => toast.success("Copied"), () => toast.error("Could not copy. Select the address and copy it by hand."));
  return (
    <>
      <Item title="Email reports" state={s.email.configured ? <Chip tone="ok">ready</Chip> : <Chip tone="warn">needs a key</Chip>}>
        <p className="max-w-2xl text-muted-foreground">
          {s.email.configured
            ? `Reports and alerts go to ${s.email.recipient ?? "the address set on the server"}.`
            : "Sending needs a Resend key, added to this project as RESEND_API_KEY. Resend's free plan is enough. With Resend's default sender, mail is only delivered to the address the Resend account was opened with."}
        </p>
        <button
          type="button"
          className={BTN}
          disabled={busy !== null || !s.email.configured}
          onClick={() =>
            void wrap("email", async () => {
              const r = await api.testEmail();
              toast.message(`Test email to ${r.to}: ${r.status}`, { description: r.detail, duration: 12_000 });
            })
          }
        >
          {busy === "email" && <Loader2 className="h-4 w-4 animate-spin" />} Send a test
        </button>
      </Item>
      <Item title="Google Drive" state={s.drive.connected ? <Chip tone="ok">connected</Chip> : s.drive.configured ? <Chip>not connected</Chip> : <Chip tone="warn">needs credentials</Chip>}>
        <p className="max-w-2xl text-muted-foreground">
          {s.drive.connected
            ? `Connected as ${s.drive.email ?? "your Google account"}. This is a separate permission from signing in. Scholium uploads only into its own folder, and every upload is listed in the project's files.`
            : "A separate permission from signing in. Scholium asks Google only for access to files it creates itself and uploads only into its own Scholium folder."}
        </p>
        {!s.drive.configured && (
          <p className="max-w-2xl text-muted-foreground">Needs a Google OAuth client, added to this project as GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, with this address as an authorised redirect:</p>
        )}
        {!s.drive.connected && (
          <p className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded-sm bg-secondary px-2 py-1 font-mono text-[0.8rem]">{s.drive.redirectUri}</code>
            <button type="button" onClick={copy} className={BTN} aria-label="Copy the redirect address">
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {s.drive.connected ? (
            <button type="button" className={BTN} disabled={busy !== null} onClick={() => void wrap("drive", async () => void (await api.driveDisconnect()))}>
              {busy === "drive" && <Loader2 className="h-4 w-4 animate-spin" />} Disconnect
            </button>
          ) : (
            <button
              type="button"
              className={BTN}
              disabled={busy !== null || !s.drive.configured}
              onClick={() =>
                void wrap("drive", async () => {
                  const { url } = await api.driveStart();
                  // Google does not show its consent screen inside a frame, so it opens in its own tab.
                  setWaitUntil(Date.now() + 10 * 60_000);
                  if (!window.open(url, "_blank")) window.location.assign(url);
                })
              }
            >
              {busy === "drive" && <Loader2 className="h-4 w-4 animate-spin" />} Connect Google Drive
            </button>
          )}
          {s.drive.folderUrl && (
            <a href={s.drive.folderUrl} target="_blank" rel="noreferrer" className={BTN}>
              <ExternalLink className="h-3.5 w-3.5" /> Open the Scholium folder
            </a>
          )}
        </div>
      </Item>
    </>
  );
}

const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

function Checks({ d, refresh }: { d: WorkspaceOverview; refresh: () => void }) {
  const [fresh, setFresh] = useState<{ results: DiagnosticResult[]; at: number } | null>(null);
  const [models, setModels] = useState<ModelKey[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const results = fresh?.results ?? d.diagnostics;
  const at = fresh?.at ?? d.diagnosticsAt;

  const run = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      setFresh(await api.diagnostics(models.length ? { models } : {}));
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
      refresh();
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="max-w-2xl text-muted-foreground">Each check makes one real request to the service and reports what came back. Nothing here is simulated: a tool that fails its check is reported to the models as unavailable.</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" className={BTN} disabled={running} onClick={() => void run()}>
          {running && <Loader2 className="h-4 w-4 animate-spin" />} Run the checks
        </button>
        {at ? <span className="text-muted-foreground">Last run {timeAgo(at)}</span> : <span className="text-muted-foreground">Not run yet</span>}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-muted-foreground">
          Also call these models once. Each is a real call at full reasoning effort and counts against the ceiling.{" "}
          {d.settings.modelAccount === "other"
            ? "Model calls are going to another Rork account (MODEL_ACCOUNT_KEY is set)."
            : d.settings.modelAccount === "project"
              ? "Model calls are going to this project's own Rork account."
              : ""}
        </legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {MODEL_KEYS.map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--rubric))]" checked={models.includes(k)} disabled={running} onChange={(e) => setModels((m) => (e.target.checked ? [...m, k] : m.filter((x) => x !== k)))} />
              <ModelTag model={k} full />
              <span className="font-mono text-[0.72rem] text-muted-foreground">{MODELS[k].id}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {error !== null && <ErrorNote error={error} />}
      {results.length > 0 && (
        <ul className="hairline divide-y border-y">
          {results.map((r) => (
            <li key={r.check} className="grid grid-cols-[1.25rem_minmax(0,9rem)_1fr] items-start gap-x-3 py-2">
              {r.ok ? <Check className="mt-0.5 h-4 w-4 text-ok" aria-label="works" /> : <X className="mt-0.5 h-4 w-4 text-destructive" aria-label="failed" />}
              <span className="break-words font-mono text-[0.8rem]">{r.check}</span>
              <span className="min-w-0 break-words">
                {r.detail} <span className="tabular text-muted-foreground">{r.ms} ms</span>
                {(r.requested !== undefined || r.reported !== undefined) && (
                  <span className="block font-mono text-[0.74rem] text-muted-foreground">
                    {r.requested !== undefined && <>asked for {show(r.requested)} </>}
                    {r.reported !== undefined && <>· provider reported {show(r.reported)}</>}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const PASS_LINE = 'copy(localStorage.getItem("rork:access_token"))';

/** Brings runs saved on the earlier Scholium site into this workspace, each from its latest checkpoint. */
function Backups({ runs, email, refresh }: { runs: RunSummary[]; email: string; refresh: () => void }) {
  const [busy, setBusy] = useState("");
  const pick = useRef<HTMLInputElement>(null);
  const all = async (): Promise<void> => {
    const parts: string[] = [];
    const missed: string[] = [];
    for (let i = 0; i < runs.length; i++) {
      setBusy(`Saving ${i + 1} of ${runs.length}`);
      try {
        const text = await api.backupRun(runs[i].id);
        JSON.parse(text);
        parts.push(text);
      } catch {
        missed.push(runs[i].title || "Untitled run");
      }
    }
    let strategy: unknown = null;
    try {
      strategy = await api.strategy();
    } catch {
      strategy = null;
    }
    const day = new Date().toISOString().slice(0, 10);
    const head = `{"scholiumBackupSet":1,"owner":${JSON.stringify(email)},"exportedAt":${JSON.stringify(new Date().toISOString())},"methods":${JSON.stringify(strategy)},"projects":[`;
    if (parts.length) saveBlob(new Blob([head, parts.join(","), "]}"], { type: "application/json" }), `scholium-backup-${day}.json`);
    setBusy("");
    if (missed.length) toast.error(`${missed.length} project${missed.length === 1 ? " was" : "s were"} not saved`, { description: missed.join(", "), duration: 15_000 });
    else toast.success(`${parts.length} project${parts.length === 1 ? "" : "s"} saved in one file.`);
  };
  const restore = async (file: File): Promise<void> => {
    setBusy("Reading the file");
    let list: unknown[] = [];
    try {
      const data = JSON.parse(await file.text()) as { scholiumBackupSet?: number; projects?: unknown[] };
      list = data.scholiumBackupSet === 1 && Array.isArray(data.projects) ? data.projects : [data];
    } catch {
      setBusy("");
      toast.error("This file could not be read as a Scholium backup.");
      return;
    }
    let ok = 0;
    const failed: string[] = [];
    for (let i = 0; i < list.length; i++) {
      setBusy(`Restoring ${i + 1} of ${list.length}`);
      const p = (list[i] ?? {}) as { scholiumBackup?: number; checkpoint?: unknown; texts?: unknown; files?: unknown; run?: { title?: string } };
      try {
        await api.restoreBackup({ scholiumBackup: p.scholiumBackup, checkpoint: p.checkpoint, texts: p.texts, files: p.files });
        ok++;
      } catch (e) {
        failed.push(`${p.run?.title || "Untitled run"}: ${errorText(e)}`);
      }
    }
    setBusy("");
    refresh();
    if (failed.length) toast.error(`${failed.length} project${failed.length === 1 ? " was" : "s were"} not restored`, { description: failed.join(" · "), duration: 20_000 });
    if (ok) toast.success(`${ok} project${ok === 1 ? "" : "s"} restored. ${ok === 1 ? "It is" : "They are"} on the Projects page.`);
  };
  return (
    <Item title="Backup files" state={<Chip>{email}</Chip>}>
      <p className="max-w-2xl text-muted-foreground">
        Everything here belongs to the Google account {email}, not to whoever hosts the site. A backup file holds each project's ledger, sources, stored source texts, uploaded files and report, and can rebuild the projects on this site or on a later copy of it. Each
        restored project arrives as a new project that continues from where the backup was taken; its spending starts again from zero. Keep the file somewhere safe, such as your Google Drive.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BTN} disabled={busy !== "" || runs.length === 0} onClick={() => void all()}>
          <Download className="h-3.5 w-3.5" /> Download every project
        </button>
        <button type="button" className={BTN} disabled={busy !== ""} onClick={() => pick.current?.click()}>
          <Upload className="h-3.5 w-3.5" /> Restore from a backup file
        </button>
        <input
          ref={pick}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void restore(f);
          }}
        />
        {busy && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {busy}
          </span>
        )}
      </div>
    </Item>
  );
}

function OldRuns({ refresh }: { refresh: () => void }) {
  const [pass, setPass] = useState("");
  const [runs, setRuns] = useState<(RunSummary & { site: number })[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const key = (r: { site: number; id: string }): string => `${r.site}:${r.id}`;
  const find = async (): Promise<void> => {
    setBusy("find");
    try {
      setRuns((await api.importList(pass)).runs);
    } catch (e) {
      toast.error("Could not read the old site", { description: errorText(e), duration: 12_000 });
    } finally {
      setBusy(null);
    }
  };
  const bring = async (r: RunSummary & { site: number }): Promise<void> => {
    setBusy(key(r));
    try {
      const made = await api.importRun(pass, r.site, r.id);
      setDone((d) => ({ ...d, [key(r)]: made.id }));
      refresh();
      toast.success(`Brought over: ${r.title || "untitled run"}`);
    } catch (e) {
      toast.error("Not brought over", { description: errorText(e), duration: 12_000 });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Item title="Runs saved on scholium.rork.app" state={runs ? <Chip>{runs.length} found</Chip> : undefined}>
      <p className="max-w-2xl text-muted-foreground">
        Each run arrives as a new project that starts from its latest saved checkpoint, with its ledger, sources and uploaded files, the same way a branch does. Its spending starts again from zero here. Nothing on the old site is changed.
      </p>
      <ol className="max-w-2xl list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>Open scholium.rork.app in another tab and sign in.</li>
        <li>Open the browser's console there (F12, then Console), paste this line and press Enter. It copies a one-hour pass.</li>
      </ol>
      <p className="flex flex-wrap items-center gap-2">
        <code className="break-all rounded-sm bg-secondary px-2 py-1 font-mono text-[0.8rem]">{PASS_LINE}</code>
        <button type="button" className={BTN} onClick={() => void navigator.clipboard.writeText(PASS_LINE).then(() => toast.success("Copied"), () => toast.error("Could not copy. Select the line and copy it by hand."))} aria-label="Copy the line">
          <Copy className="h-3.5 w-3.5" /> Copy
        </button>
      </p>
      <div className="flex max-w-xl items-end gap-2">
        <Field label="Pass from the old site. It is used for the transfer and not saved">
          <Input aria-label="Pass from the old site" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
        <button type="button" className={BTN} disabled={busy !== null || pass.trim().length < 20} onClick={() => void find()}>
          {busy === "find" && <Loader2 className="h-4 w-4 animate-spin" />} Find my runs
        </button>
      </div>
      {runs && runs.length === 0 && <p className="text-muted-foreground">The old site has no runs for this account.</p>}
      {runs && runs.length > 0 && (
        <ul className="max-w-2xl divide-y border-y">
          {runs.map((r) => (
            <li key={key(r)} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="truncate font-medium">{r.title || "Untitled run"}</div>
                <div className="text-xs text-muted-foreground">
                  {r.status}, cycle {r.cycle}, updated {timeAgo(r.updatedAt)}
                  {r.site === 1 ? ", from the old preview" : ""}
                </div>
              </div>
              {done[key(r)] ? (
                <Link to={`/r/${done[key(r)]}`} className={BTN}>
                  <Check className="h-3.5 w-3.5" /> Open
                </Link>
              ) : (
                <button type="button" className={BTN} disabled={busy !== null} onClick={() => void bring(r)}>
                  {busy === key(r) && <Loader2 className="h-4 w-4 animate-spin" />} Bring over
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Item>
  );
}

export default function Settings() {
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const { access, signOut } = useAuth();
  const [busy, setBusy] = useState(false);

  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: ["workspace"] });
  const save: Save = async (patch, done) => {
    setBusy(true);
    try {
      await api.saveSettings(patch);
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      toast.success(done);
      return true;
    } catch (e) {
      toast.error("Not saved", { description: errorText(e), duration: 12_000 });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const d = ws.data;
  return (
    <Page eyebrow="Workspace" title="Settings">
      {!d ? (
        ws.isError ? (
          <ErrorNote error={ws.error} retry={() => void ws.refetch()} />
        ) : (
          <Loading what="Loading the settings" />
        )
      ) : (
        <div className="space-y-14">
          <Section title="Spending">
            <Spending key={d.budget.capUsd} d={d} save={save} busy={busy} />
          </Section>
          <Section title="Free allowance of the server">
            <Allowance u={d.usage} />
          </Section>
          <Section title="Connections">
            <Connections s={d.settings} refresh={refresh} />
            <Exa key={`${d.settings.exaMonthlyCap}`} s={d.settings} save={save} busy={busy} />
            <Lean key={d.settings.leanUrl} s={d.settings} save={save} busy={busy} />
          </Section>
          <Section title="Backups and earlier work">
            {d.vault && <Storage v={d.vault} refresh={refresh} />}
            {d.vault?.on && <StoreCheck runs={d.runs} />}
            {d.vault?.on && <MoveKit email={ALLOWED_EMAIL} />}
            <Backups runs={d.runs} email={ALLOWED_EMAIL} refresh={refresh} />
            <OldRuns refresh={refresh} />
          </Section>
          <Section title="Connection checks">
            <Checks d={d} refresh={refresh} />
          </Section>
          <Section title="Method notes">
            <Methods />
          </Section>
          <Section title="This session">
            <div className="space-y-4 text-sm">
              <p className="max-w-2xl text-muted-foreground">
                Signed in as <span className="text-foreground">{access.state === "allowed" ? access.email : "…"}</span>. Only this Google account can open the workspace, and the server checks it again on every request. Projects that are running keep running while you are signed out.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <ThemeToggle />
                <button type="button" className={BTN} onClick={signOut}>
                  <LogOut className="h-3.5 w-3.5" /> Sign out
                </button>
              </div>
              <p className="text-xs text-muted-foreground">Scholium {d.version}</p>
            </div>
          </Section>
        </div>
      )}
    </Page>
  );
}
