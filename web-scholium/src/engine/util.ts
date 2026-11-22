import type { QuoteStatus } from "../shared/types";

export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.7);
  const tail = Math.max(0, n - head);
  return `${s.slice(0, head)}\n…[${s.length - n} characters omitted]…\n${tail ? s.slice(-tail) : ""}`;
}

export const oneLine = (s: string, n = 160): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

/** Rough token estimate used only for budgeting and context limits. */
export const estTokens = (chars: number): number => Math.ceil(chars / 3.2);

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(s);
}

export function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const STOP = new Set(
  "a an and are as at be by for from has have if in is it its of on or that the this to was were will with which we you your not can do does into than then there their about over under between".split(" "),
);

export function words(s: string): string[] {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

export function keyTerms(s: string): string[] {
  return words(s).filter((w) => w.length > 1 && !STOP.has(w));
}

/** Jaccard similarity of the key terms of two texts. */
export function similarity(a: string, b: string): number {
  const A = new Set(keyTerms(a));
  const B = new Set(keyTerms(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Canonical form for comparing quoted text with a retrieved document. */
export function normQuote(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\u00ad/g, "")
    .replace(/-\s*\n\s*/g, "")
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[*_`#$\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function lcsLen(a: string[], b: string[]): number {
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Machine check of a quotation against retrieved text.
 * verified: the quote appears verbatim (modulo whitespace, typographic quotes and markup).
 * approximate: at least 85% of its words appear in order inside one passage.
 */
export function checkQuote(text: string, quote: string): Exclude<QuoteStatus, "unverifiable"> {
  const q = normQuote(quote);
  if (!q) return "not_found";
  const t = normQuote(text);
  if (t.includes(q)) return "verified";
  const qw = words(q);
  const tw = words(t);
  const m = qw.length;
  if (m < 4 || tw.length < m) return "not_found";
  const need = new Map<string, number>();
  for (const w of qw) need.set(w, (need.get(w) ?? 0) + 1);
  const win = Math.min(tw.length, m + Math.ceil(m * 0.25));
  const have = new Map<string, number>();
  let matched = 0;
  const add = (w: string) => {
    const n = need.get(w);
    if (n === undefined) return;
    const h = (have.get(w) ?? 0) + 1;
    have.set(w, h);
    if (h <= n) matched++;
  };
  const remove = (w: string) => {
    const n = need.get(w);
    if (n === undefined) return;
    const h = have.get(w) ?? 0;
    have.set(w, h - 1);
    if (h <= n) matched--;
  };
  for (let i = 0; i < tw.length; i++) {
    add(tw[i]);
    if (i >= win) remove(tw[i - win]);
    if (i >= win - 1 || i === tw.length - 1) {
      if (matched >= m * 0.85) {
        const start = Math.max(0, i - win + 1);
        if (lcsLen(qw, tw.slice(start, i + 1)) >= m * 0.85) return "approximate";
      }
    }
  }
  return "not_found";
}

/** Text around the first occurrence of a quote, for reviewers auditing a citation. */
export function quoteContext(text: string, quote: string, radius = 600): string | null {
  const probe = normQuote(quote).split(" ").slice(0, 6).join(" ");
  if (!probe) return null;
  const lower = text.toLowerCase().replace(/\s+/g, " ");
  const at = lower.indexOf(probe);
  if (at < 0) return null;
  const flat = text.replace(/\s+/g, " ");
  return flat.slice(Math.max(0, at - radius), Math.min(flat.length, at + quote.length + radius));
}

export function fmtUsd(n: number): string {
  return n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : JSON.stringify(e);
}

export function safeJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}
