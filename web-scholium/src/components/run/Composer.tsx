// The live side of a project: what the backend reports as it happens, and the queue of messages to the models.
import { ArrowDown, ArrowUp, Check, Loader2, Paperclip, Pencil, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { clock, modelColor, timeAgo } from "@/components/bits";
import { FileDrop } from "@/components/FileDrop";
import { MathText, Ref } from "@/components/Markdown";
import { Textarea } from "@/components/ui/textarea";
import { api, errorText } from "@/lib/api";
import { sendFiles } from "@/lib/files";
import type { ActivityEvent } from "@/shared/types";

import { useRunCtx, Who } from "./ctx";

const DOT: Record<ActivityEvent["level"], string> = { info: "bg-muted-foreground/40", warn: "bg-warn", error: "bg-destructive", success: "bg-ok" };

export function Activity() {
  const { view } = useRunCtx();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [notable, setNotable] = useState(false);
  const events = useMemo(() => (notable ? view.events.filter((e) => e.level !== "info") : view.events), [view.events, notable]);
  const last = events[events.length - 1]?.seq;
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [last]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="eyebrow">Activity</span>
        <button type="button" onClick={() => setNotable((v) => !v)} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          {notable ? "Show everything" : "Only results and problems"}
        </button>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
      >
        {events.length ? (
          events.map((e) => (
            <div key={e.seq} className="flex gap-2 py-1 text-[0.82rem] leading-snug">
              <span className="tabular shrink-0 pt-px font-mono text-[0.68rem] text-muted-foreground">{clock(e.at)}</span>
              <span className={`mt-[0.4rem] h-1.5 w-1.5 shrink-0 rounded-full ${DOT[e.level]}`} />
              <span className={`min-w-0 break-words ${e.level === "error" ? "text-destructive" : ""}`}>
                {e.agentId ? <Who id={e.agentId} className="mr-1.5 text-[0.78rem] font-medium" /> : null}
                <MathText text={e.text} /> {e.ref ? <Ref id={e.ref} /> : null}
              </span>
            </div>
          ))
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">Nothing has happened yet. Every line here is something the backend reported; nothing is estimated.</p>
        )}
      </div>
    </div>
  );
}

export function Composer() {
  const { id, data, run, store, view } = useRunCtx();
  const [text, setText] = useState("");
  const [target, setTarget] = useState("all");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [files, setFiles] = useState(false);
  const [sent, setSent] = useState(false);

  const leads = useMemo(() => data.agent.filter((a) => a.kind === "lead" && a.active), [data.agent]);
  const queued = useMemo(() => data.instruction.filter((i) => i.status === "queued").sort((a, b) => a.order - b.order), [data.instruction]);
  const delivered = useMemo(() => data.instruction.filter((i) => i.status === "delivered").reverse(), [data.instruction]);
  const to = target === "all" || leads.some((l) => l.id === target) ? target : "all";

  const call = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      if (view.link !== "live") store.resync();
      return true;
    } catch (e) {
      toast.error(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    if (await call(() => api.instruct(id, body, to))) setText("");
  };

  const move = (index: number, by: number) => {
    const ids = queued.map((i) => i.id);
    const a = ids[index];
    const b = ids[index + by];
    if (a === undefined || b === undefined) return;
    ids[index] = b;
    ids[index + by] = a;
    void call(() => api.reorderInstructions(id, ids));
  };

  const upload = async (list: File[]) => {
    setBusy(true);
    try {
      await sendFiles(id, list, (s) => (s.ok ? toast.success(`${s.name} added`, { description: s.note }) : toast.error(`${s.name} was not added`, { description: s.note })));
      if (view.link !== "live") store.resync();
    } finally {
      setBusy(false);
    }
  };

  const when =
    run.status === "running"
      ? "Handed to the lead at its next turn."
      : run.status === "draft"
        ? "The project has not started; messages wait in the queue until it does."
        : "The project is not running; messages wait in the queue until it runs again.";
  const name = (t: string): string => (t === "all" ? "all leads" : (data.agent.find((a) => a.id === t)?.name ?? t));

  return (
    <div className="no-print shrink-0 border-t bg-card/50">
      {queued.length || delivered.length ? (
        <div className="max-h-52 overflow-y-auto border-b px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Queue · {queued.length}</span>
            {delivered.length ? (
              <button type="button" onClick={() => setSent((v) => !v)} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                {sent ? "Hide delivered" : `Delivered · ${delivered.length}`}
              </button>
            ) : null}
          </div>
          {queued.map((i, n) => (
            <div key={i.id} className="mt-1.5 rounded-sm border bg-background p-2 text-sm">
              {editing?.id === i.id ? (
                <>
                  <Textarea value={editing.text} onChange={(e) => setEditing({ id: i.id, text: e.target.value })} rows={3} className="text-sm" autoFocus />
                  <div className="mt-1.5 flex justify-end gap-2">
                    <button type="button" onClick={() => setEditing(null)} className="text-xs text-muted-foreground hover:text-foreground">
                      Discard
                    </button>
                    <button
                      type="button"
                      disabled={busy || !editing.text.trim()}
                      onClick={async () => {
                        const next = editing.text.trim();
                        if (await call(() => api.editInstruction(id, i.id, next))) setEditing(null);
                      }}
                      className="press inline-flex items-center gap-1 rounded-sm bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40"
                    >
                      <Check className="h-3 w-3" /> Save
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words"><MathText text={i.text} /></p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      to {name(i.target)} · {timeAgo(i.createdAt)}
                      {i.editedAt ? " · edited" : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center text-muted-foreground">
                    <IconBtn label="Move up" disabled={busy || n === 0} onClick={() => move(n, -1)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </IconBtn>
                    <IconBtn label="Move down" disabled={busy || n === queued.length - 1} onClick={() => move(n, 1)}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </IconBtn>
                    <IconBtn label="Edit" disabled={busy} onClick={() => setEditing({ id: i.id, text: i.text })}>
                      <Pencil className="h-3.5 w-3.5" />
                    </IconBtn>
                    <IconBtn label="Cancel this message" disabled={busy} onClick={() => void call(() => api.cancelInstruction(id, i.id))}>
                      <X className="h-3.5 w-3.5" />
                    </IconBtn>
                  </div>
                </div>
              )}
            </div>
          ))}
          {sent
            ? delivered.map((i) => (
                <div key={i.id} className="mt-1.5 border-l-2 pl-2 text-sm text-muted-foreground">
                  <p className="whitespace-pre-wrap break-words"><MathText text={i.text} /></p>
                  <p className="mt-0.5 text-xs">
                    {i.deliveries.length ? i.deliveries.map((d) => `${name(d.agentId)} at ${clock(d.at)}`).join(" · ") : "delivered"}
                  </p>
                </div>
              ))
            : null}
        </div>
      ) : null}

      <div className="p-3">
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">To</span>
          {[{ id: "all", name: "All leads", model: undefined }, ...leads].map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => setTarget(l.id)}
              aria-pressed={to === l.id}
              className={`press inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 ${to === l.id ? "border-foreground bg-foreground text-background" : "bg-background hover:border-foreground/50"}`}
            >
              {l.model ? <span className="h-2 w-2 rounded-full" style={{ background: modelColor(l.model) }} /> : null}
              {l.name}
            </button>
          ))}
        </div>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
          placeholder="Redirect the work, add a constraint, ask a question…"
          className="resize-none bg-background text-sm"
        />
        <div className="mt-2 flex items-center gap-2">
          <button type="button" onClick={() => setFiles((v) => !v)} aria-pressed={files} className="press inline-flex h-8 items-center gap-1.5 rounded-sm border bg-background px-2 text-xs hover:border-foreground/50">
            <Paperclip className="h-3.5 w-3.5" /> Add files
          </button>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={when}>
            {when}
          </span>
          <button type="button" onClick={() => void send()} disabled={busy || !text.trim()} className="press inline-flex h-8 items-center gap-1.5 rounded-sm bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-40">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Queue
          </button>
        </div>
        {files ? (
          <div className="mt-2">
            <FileDrop compact disabled={busy} onFiles={(list) => void upload(list)} />
            <p className="mt-1 text-xs text-muted-foreground">Files are given to the models as material to study, never as instructions.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function IconBtn({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="press flex h-7 w-7 items-center justify-center rounded-sm hover:bg-secondary hover:text-foreground disabled:opacity-30">
      {children}
    </button>
  );
}
