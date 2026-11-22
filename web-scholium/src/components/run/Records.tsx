// The project's records: files, emails, every model call as the provider reported it, and checkpoints to branch from.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, GitBranch, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Chip, ErrorNote, Loading, Section, clock, timeAgo, usd } from "@/components/bits";
import { MathText, Ref } from "@/components/Markdown";
import { fmtDuration } from "@/engine/util";
import { api, errorText, saveText } from "@/lib/api";
import { fileSize } from "@/lib/files";
import type { Usage } from "@/shared/models";
import { PHASE_NAMES, type Upload } from "@/shared/types";

import { brief, useRunCtx, Who, words } from "./ctx";

/** Only web addresses become links; anything else a model or a document supplied stays plain text. */
export const safeUrl = (u?: string): string | undefined => (u && /^https?:\/\//i.test(u) ? u : undefined);
export const none = (text: string) => <p className="py-2 text-sm text-muted-foreground">{text}</p>;
const link = "underline decoration-[hsl(var(--rule))] underline-offset-2 hover:decoration-[hsl(var(--rubric))]";

export function Row({ id, chips, children, meta }: { id?: string; chips?: ReactNode; children: ReactNode; meta?: ReactNode }) {
  return (
    <li className="border-b py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {id ? <Ref id={id} /> : null}
        {chips}
      </div>
      <div className="mt-1 break-words text-sm">{children}</div>
      {meta ? <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">{meta}</div> : null}
    </li>
  );
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={link}>
      {children}
    </a>
  );
}

export function Files() {
  const { id, data, run } = useRunCtx();
  const [busy, setBusy] = useState("");
  const download = async (u: Upload) => {
    setBusy(u.id);
    try {
      await api.downloadUpload(id, u);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const folder = safeUrl(run.driveFolderUrl);
  const get = "press inline-flex items-center gap-1 rounded-sm border bg-background px-2 py-0.5 text-xs hover:border-foreground/50 disabled:opacity-40";
  return (
    <div className="space-y-8">
      <Section title="Your files" aside={<span className="tabular text-xs text-muted-foreground">{data.upload.length || ""}</span>}>
        {data.upload.length ? (
          <ul>
            {data.upload.map((u) => (
              <Row
                key={u.id}
                id={u.id}
                chips={<span className="eyebrow">{u.kind}</span>}
                meta={
                  <>
                    <span>{fileSize(u.size)}</span>
                    {u.pages ? <span>{u.pages} pages</span> : null}
                    <span>{u.textChars ? `${u.textChars.toLocaleString()} characters of text readable by the models` : "no readable text"}</span>
                    <span>added {timeAgo(u.addedAt)}</span>
                    {u.sourceId ? <Ref id={u.sourceId} /> : null}
                    <button type="button" disabled={busy === u.id} onClick={() => void download(u)} className={get}>
                      {busy === u.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} Download
                    </button>
                  </>
                }
              >
                {u.name}
              </Row>
            ))}
          </ul>
        ) : (
          none("You have not added any files. Add them from the message box at any time.")
        )}
      </Section>

      <Section title="Written by the models" aside={<span className="tabular text-xs text-muted-foreground">{data.artifact.length || ""}</span>}>
        {data.artifact.length ? (
          <ul>
            {data.artifact.map((a) => (
              <Row
                key={a.id}
                id={a.id}
                chips={<span className="eyebrow">{a.kind}</span>}
                meta={
                  <>
                    <span className="font-mono">{a.filename}</span>
                    <span>version {a.version}</span>
                    <Who id={a.byAgent} />
                    {a.claimIds.map((c) => (
                      <Ref key={c} id={c} />
                    ))}
                    <button type="button" onClick={() => saveText(a.content, a.filename || `${a.id}.txt`, "text/plain")} className={get}>
                      <Download className="h-3 w-3" /> Download
                    </button>
                  </>
                }
              >
                <MathText text={a.title} />
              </Row>
            ))}
          </ul>
        ) : (
          none("No documents, tables or code files have been saved yet.")
        )}
      </Section>

      <Section title="Google Drive">
        {!run.config.drive ? (
          none("Copying to Google Drive is off for this project.")
        ) : (
          <>
            {folder ? (
              <p className="py-1 text-sm">
                <Ext href={folder}>Open this project's folder in Google Drive</Ext>
                {run.driveLastSyncAt ? <span className="text-muted-foreground"> · last copied {timeAgo(run.driveLastSyncAt)}</span> : null}
              </p>
            ) : (
              none("Nothing has been copied to Google Drive yet.")
            )}
            {run.driveError ? <p className="py-1 text-sm text-destructive">{run.driveError}</p> : null}
            <ul>
              {data.drivefile.map((f) => (
                <Row key={f.id} meta={f.error ? <span className="text-destructive">{f.error}</span> : <span>{f.syncedAt ? `copied ${timeAgo(f.syncedAt)}` : "not copied yet"}</span>}>
                  {f.fileId && !f.error ? <Ext href={`https://drive.google.com/file/d/${encodeURIComponent(f.fileId)}/view`}>{f.name}</Ext> : f.name}
                </Row>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="Emails" aside={<span className="tabular text-xs text-muted-foreground">{data.email.length || ""}</span>}>
        {data.email.length ? (
          <ul>
            {[...data.email].reverse().map((m) => (
              <Row
                key={m.id}
                id={m.id}
                chips={
                  <>
                    <Chip tone={m.status === "sent" ? "ok" : m.status === "failed" ? "bad" : "muted"}>{m.status}</Chip>
                    <span className="eyebrow">{m.kind}</span>
                  </>
                }
                meta={
                  <>
                    <span>to {m.to}</span>
                    <span>{timeAgo(m.at)}</span>
                    {m.detail ? <span>{m.detail}</span> : null}
                  </>
                }
              >
                {m.subject}
              </Row>
            ))}
          </ul>
        ) : (
          none("No email has been sent or attempted for this project.")
        )}
      </Section>
    </div>
  );
}

/** Token counts exactly as the provider reported them. Output includes reasoning. */
export const tokens = (u: Usage): string =>
  (
    [
      ["input", u.input],
      ["read from cache", u.cacheRead],
      ["written to cache", u.cacheWrite],
      ["output", u.output],
      ["of which reasoning", u.reasoning],
    ] as const
  )
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v.toLocaleString()} ${k}`)
    .join(" · ");

export function Calls() {
  const { id, run } = useRunCtx();
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ["calls", id], queryFn: ({ signal }) => api.calls(id, signal), refetchInterval: run.status === "running" ? 20_000 : false });
  if (q.isPending) return <Loading what="Loading the model calls" />;
  if (q.isError) return <ErrorNote error={q.error} retry={() => void q.refetch()} />;
  const calls = [...q.data.calls].sort((a, b) => b.at - a.at);
  if (!calls.length) return none("No model has been called yet.");
  const failed = calls.filter((c) => c.status === "error").length;
  const shown = all ? calls : calls.slice(0, 120);
  return (
    <Section
      title="Model calls"
      aside={
        <span className="tabular text-xs text-muted-foreground">
          {calls.length} calls · {usd(calls.reduce((s, c) => s + c.costUsd, 0))}
          {failed ? ` · ${failed} failed` : ""}
        </span>
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">Each line is one request as it was sent and as the provider answered it: the model asked for, the model that reported back, the effort requested, and which revision of the working-method notes the instructions carried.</p>
      <ul>
        {shown.map((c) => (
          <Row
            key={c.id}
            id={c.id}
            chips={
              <>
                <Chip tone={c.status === "ok" ? "ok" : "bad"}>{c.status === "ok" ? "ok" : `failed${c.httpStatus ? ` · ${c.httpStatus}` : ""}`}</Chip>
                <span className="font-mono text-xs">{c.gatewayModel}</span>
                {c.providerModel && c.providerModel !== c.gatewayModel ? <span className="font-mono text-xs text-muted-foreground">answered as {c.providerModel}</span> : null}
              </>
            }
            meta={
              <>
                <span>{clock(c.at)}</span>
                <Who id={c.agentId} />
                <span>effort {c.requested.effort}</span>
                <span>method notes {c.promptVersion ?? "not recorded"}</span>
                <span>{tokens(c.usage) || "no token counts reported"}</span>
                <span>{usd(c.costUsd)}</span>
                <span>{fmtDuration(c.ms)}</span>
                {c.attempt > 1 ? <span>attempt {c.attempt}</span> : null}
              </>
            }
          >
            {c.purpose} <span className="text-muted-foreground">· turn {c.turn}</span>
            {c.error ? <span className="mt-0.5 block font-mono text-xs text-destructive">{brief(c.error, 400)}</span> : null}
          </Row>
        ))}
      </ul>
      {calls.length > shown.length ? (
        <button type="button" onClick={() => setAll(true)} className="mt-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          Show all {calls.length}
        </button>
      ) : null}
    </Section>
  );
}

export function Checkpoints() {
  const { id, data } = useRunCtx();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState("");
  const branch = async (cid: string) => {
    setBusy(cid);
    try {
      const res = await api.branch(id, cid);
      void qc.invalidateQueries({ queryKey: ["workspace"] });
      toast.success("Branch created", { description: "A new project that carries the ledger as it stood at this checkpoint." });
      nav(`/r/${res.id}`);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy("");
    }
  };
  if (!data.checkpoint.length) return none("No checkpoint has been saved yet. One is saved at the end of every cycle and whenever the project pauses or stops.");
  return (
    <Section title="Checkpoints" aside={<span className="tabular text-xs text-muted-foreground">{data.checkpoint.length}</span>}>
      <ul>
        {[...data.checkpoint].reverse().map((k) => (
          <Row
            key={k.id}
            id={k.id}
            chips={
              <span className="text-xs text-muted-foreground">
                cycle {k.cycle} · {PHASE_NAMES[k.phase]} · {timeAgo(k.at)} · {usd(k.spendUsd)} spent by then
              </span>
            }
            meta={
              <>
                {Object.entries(k.counts)
                  .filter(([, v]) => v > 0)
                  .map(([name, v]) => (
                    <span key={name}>
                      {v} {words(name)}
                    </span>
                  ))}
                <button type="button" disabled={busy !== ""} onClick={() => void branch(k.id)} className="press inline-flex items-center gap-1 rounded-sm border bg-background px-2 py-0.5 text-xs text-foreground hover:border-foreground/50 disabled:opacity-40">
                  {busy === k.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />} Branch from here
                </button>
              </>
            }
          >
            {k.reason}
            {k.summary ? <span className="mt-0.5 block text-muted-foreground"><MathText text={brief(k.summary, 320)} /></span> : null}
          </Row>
        ))}
      </ul>
    </Section>
  );
}
