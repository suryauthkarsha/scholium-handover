// One task's exchange with its model, exactly as saved: instructions, replies, tool calls and tool results.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ErrorNote, Loading } from "@/components/bits";
import { Code, Markdown, MathText } from "@/components/Markdown";
import { tailText } from "@/shared/math";
import { api } from "@/lib/api";
import type { Msg } from "@/shared/types";

import { brief, useRunCtx } from "./ctx";

function Fold({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > 700;
  return (
    <>
      <p className="whitespace-pre-wrap break-words text-sm"><MathText text={long && !all ? `${text.slice(0, 600)}…` : text} /></p>
      {long ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          {all ? "Show less" : `Show all ${text.length.toLocaleString()} characters`}
        </button>
      ) : null}
    </>
  );
}

const fold = "rounded-sm border bg-card/50 px-2 py-1 text-sm";

function Turn({ m }: { m: Msg }) {
  if (m.role === "user") {
    return (
      <div className="border-l-2 pl-3">
        <p className="eyebrow mb-1">{m.origin === "user" ? "You" : m.origin === "pack" ? "Material given to the model" : "Instructions from Scholium"}</p>
        <Fold text={m.text} />
        {m.attachments?.length ? <p className="mt-1 text-xs text-muted-foreground">Attached: {m.attachments.map((a) => a.name).join(", ")}</p> : null}
      </div>
    );
  }
  if (m.role === "assistant") {
    return (
      <div>
        <p className="eyebrow mb-1">Model</p>
        {m.thinking ? (
          <details className="mb-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">Reasoning summary, as the provider reported it</summary>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm italic text-muted-foreground"><MathText text={m.thinking} /></p>
          </details>
        ) : null}
        {m.text ? <Markdown text={m.text} compact /> : null}
        <div className="mt-1.5 space-y-1.5">
          {m.calls.map((c) => (
            <details key={c.id} className={fold}>
              <summary className="cursor-pointer font-mono text-xs">
                <span className="text-muted-foreground">uses </span>
                {c.name}
                <span className="ml-2 text-muted-foreground">{brief(c.badJson ?? JSON.stringify(c.args), 80)}</span>
              </summary>
              <Code text={c.badJson ?? JSON.stringify(c.args, null, 2)} max={20_000} className="mt-1" />
            </details>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {m.results.map((r) => (
        <details key={r.callId} className={fold}>
          <summary className="cursor-pointer font-mono text-xs">
            <span className={r.isError ? "text-destructive" : "text-muted-foreground"}>{r.isError ? "error from " : "result of "}</span>
            {r.name}
            <span className="ml-2 text-muted-foreground">{brief(r.output, 80)}</span>
          </summary>
          <Code text={r.output} max={20_000} className="mt-1" />
        </details>
      ))}
    </div>
  );
}

export function Transcript({ taskId }: { taskId: string }) {
  const { id, data, view } = useRunCtx();
  const saved = data.task.find((t) => t.id === taskId)?.msgCount ?? 0;
  const q = useQuery({ queryKey: ["messages", id, taskId, saved], queryFn: ({ signal }) => api.messages(id, taskId, signal), placeholderData: keepPreviousData });
  const stream = view.streams.find((s) => s.taskId === taskId);
  if (q.isPending) return <Loading what="Loading the transcript" />;
  if (q.isError) return <ErrorNote error={q.error} retry={() => void q.refetch()} />;
  const live = stream ? stream.text || stream.thinking : "";
  return (
    <div className="space-y-4">
      {q.data.msgs.length ? q.data.msgs.map((m, i) => <Turn key={i} m={m} />) : <p className="text-sm text-muted-foreground">Nothing has been exchanged in this task yet.</p>}
      {live ? (
        <div>
          <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="live-dot" /> {stream?.text ? "writing now" : "reasoning now"} — not yet saved
          </p>
          <p className="whitespace-pre-wrap break-words font-serif text-[0.93rem] leading-relaxed"><MathText text={tailText(live, 4000)} /></p>
        </div>
      ) : null}
    </div>
  );
}
