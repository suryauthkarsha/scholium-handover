// Reading files in the browser before they are sent. PDF text is extracted here because the server has no PDF
// reader. The server keeps the original bytes too, and treats the extracted text as untrusted material:
// agents may quote it, never obey it.
import { api, errorText } from "@/lib/api";
import type { Upload } from "@/shared/types";

export const MAX_FILE_BYTES = 12_000_000;
export const ACCEPT = ".pdf,.txt,.md,.tex,.bib,.csv,.tsv,.json,.py,.sage,.gp,.g,.lean,.png,.jpg,.jpeg,.webp,.gif";

export const fileSize = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);

const isPdf = (f: File): boolean => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

/** The text layer of a PDF, page by page. A scanned PDF has none, and that is reported rather than guessed at. */
export async function pdfText(file: File): Promise<{ text: string; pages: number; hasText: boolean }> {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const doc = await task.promise;
    const parts: string[] = [];
    let chars = 0;
    let found = 0;
    for (let p = 1; p <= doc.numPages && chars < 1_900_000; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let body = "";
      for (const it of content.items) if ("str" in it) body += it.str + (it.hasEOL ? "\n" : " ");
      body = body.trim();
      found += body.length;
      const text = `[page ${p}]\n${body}`;
      parts.push(text);
      chars += text.length;
    }
    return { text: parts.join("\n\n"), pages: doc.numPages, hasText: found > 0 };
  } finally {
    await task.destroy();
  }
}

export interface Sent {
  name: string;
  ok: boolean;
  upload?: Upload;
  note: string;
}

/** Sends files one at a time and reports each as it finishes. One failure does not stop the rest. */
export async function sendFiles(runId: string, files: File[], each?: (s: Sent) => void): Promise<Sent[]> {
  const out: Sent[] = [];
  for (const file of files) {
    let s: Sent;
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error(`Larger than the ${fileSize(MAX_FILE_BYTES)} the workspace accepts.`);
      let text: string | undefined;
      let pages: number | undefined;
      let note = "";
      if (isPdf(file)) {
        try {
          const r = await pdfText(file);
          pages = r.pages;
          if (r.hasText) text = r.text;
          else note = "No text layer was found (a scan?), so agents get the file but cannot quote from it.";
        } catch (e) {
          note = `Its text could not be read in the browser (${errorText(e)}). The file itself was stored.`;
        }
      }
      const r = await api.upload(runId, file, text, pages);
      s = { name: file.name, ok: r.ok !== false, upload: r.upload, note };
    } catch (e) {
      s = { name: file.name, ok: false, note: errorText(e) };
    }
    out.push(s);
    each?.(s);
  }
  return out;
}
