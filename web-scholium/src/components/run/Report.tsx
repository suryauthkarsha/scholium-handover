// The living report: rebuilt from the ledger as the backend reports changes, with exports and a print view.
import { Archive, Download, Loader2, Printer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { Markdown } from "@/components/Markdown";
import { buildReport, type Data } from "@/engine/report";
import { api, errorText, saveText, type ExportFormat } from "@/lib/api";

import { useRunCtx } from "./ctx";

/** Dated by the backend's last report, so that nothing in it is extrapolated by the browser. */
const build = (d: Data): string => {
  const run = d.run[0];
  return buildReport(d, { full: false, now: run ? (run.lastTickAt ?? run.endedAt ?? run.createdAt) : undefined });
};

const EXPORTS: { format: ExportFormat; label: string; note: string }[] = [
  { format: "md", label: "Markdown", note: "The full report, with experiment code and output" },
  { format: "tex", label: "LaTeX", note: "The same report as a .tex file" },
  { format: "json", label: "All data", note: "Every record of the project as JSON" },
];

export default function Report() {
  const { id, data, run } = useRunCtx();
  const [md, setMd] = useState(() => build(data));
  const [busy, setBusy] = useState<ExportFormat | "">("");
  const [printing, setPrinting] = useState(false);
  const latest = useRef(data);
  const timer = useRef<number | undefined>(undefined);

  // At most one rebuild every few seconds, however fast the changes arrive.
  useEffect(() => {
    latest.current = data;
    if (timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setMd(build(latest.current));
    }, 4000);
  }, [data]);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    },
    [],
  );

  // Printing uses a copy placed directly in the page, outside the app's scrolling panels.
  useEffect(() => {
    if (!printing) return;
    document.body.classList.add("printing-report");
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done);
    const t = window.setTimeout(() => window.print(), 250);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("afterprint", done);
      document.body.classList.remove("printing-report");
    };
  }, [printing]);

  const save = async (format: ExportFormat) => {
    setBusy(format);
    try {
      const f = await api.exportRun(id, format);
      saveText(f.content, f.filename, f.mime);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const [backing, setBacking] = useState(false);
  const backup = async () => {
    setBacking(true);
    try {
      const name = (run.config.title || "scholium-project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "scholium-project";
      saveText(await api.backupRun(id), `${name}.backup.json`, "application/json");
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBacking(false);
    }
  };

  const button = "press inline-flex h-8 items-center gap-1.5 rounded-sm border bg-background px-2.5 text-xs hover:border-foreground/50 disabled:opacity-40";
  return (
    <div className="mx-auto max-w-3xl px-5 py-6">
      <div className="no-print mb-6 flex flex-wrap items-center gap-2 border-b pb-4">
        <span className="eyebrow mr-auto">{run.goalReached ? "Final report" : "Report so far — a checkpoint, not a final result"}</span>
        {EXPORTS.map((x) => (
          <button key={x.format} type="button" title={x.note} disabled={busy !== ""} onClick={() => void save(x.format)} className={button}>
            {busy === x.format ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} {x.label}
          </button>
        ))}
        <button type="button" title="One file with the ledger, sources, uploaded files and report. It can rebuild this project from Settings, on this site or a later one." disabled={backing} onClick={() => void backup()} className={button}>
          {backing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />} Backup
        </button>
        <button
          type="button"
          title="Opens the print dialog, where the report can be saved as a PDF"
          onClick={() => {
            setMd(build(data));
            setPrinting(true);
          }}
          className={button}
        >
          <Printer className="h-3.5 w-3.5" /> PDF
        </button>
      </div>
      <Markdown text={md} />
      {printing
        ? createPortal(
            <div className="print-sheet">
              <Markdown text={md} />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
