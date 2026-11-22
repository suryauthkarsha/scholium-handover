// Everything the engine needs from the outside world, behind one interface so tests can replace it.
import type { ToolStatus } from "../shared/types";
import { GATEWAY, type Llm } from "./providers";
import type { ActiveMethod } from "./strategy";
import { errText, keyTerms, safeJson } from "./util";

export interface WebResult {
  title: string;
  url: string;
  date?: string;
  authors: string[];
  text: string;
}

export interface Paper {
  title: string;
  authors: string[];
  date?: string;
  venue?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  abstract: string;
  /** Retrieval API that returned this record. */
  via: string;
}

export interface FetchedDoc {
  title?: string;
  text: string;
  via: string;
  complete: boolean;
}

export interface OeisEntry {
  id: string;
  name: string;
  data: string;
  comments: string[];
  formulas: string[];
  references: string[];
  url: string;
}

export interface LeanOutcome {
  ok: boolean;
  errors: string[];
  warnings: string[];
  infos: string[];
  /** Axioms reported by `#print axioms`; undefined when the report was not produced. */
  axioms?: string[];
  versions: string;
  log: string;
  /** Set when the checker itself could not be reached or did not finish. */
  infraError?: string;
}

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

export interface EmailResult {
  status: "sent" | "failed" | "skipped";
  detail: string;
  to: string;
}

export interface DriveApi {
  status(): Promise<{ connected: boolean; detail: string }>;
  ensureRunFolder(title: string): Promise<{ id: string; url: string }>;
  /** Creates or replaces a file and returns its Drive file id. */
  putFile(folderId: string, name: string, mime: string, content: string, existingFileId?: string): Promise<string>;
}

export interface Services {
  now(): number;
  llm: Llm;
  webSearch(query: string, opts: { num: number; category?: string }, signal?: AbortSignal): Promise<{ results: WebResult[]; via: string }>;
  literature(query: string, max: number, signal?: AbortSignal): Promise<{ papers: Paper[]; backends: Record<string, string> }>;
  fetchDocument(url: string, signal?: AbortSignal): Promise<FetchedDoc>;
  oeis(query: string, signal?: AbortSignal): Promise<OeisEntry[]>;
  sage(code: string, signal?: AbortSignal): Promise<{ ok: boolean; stdout: string; error?: string }>;
  lean(source: string, theoremName: string, signal?: AbortSignal): Promise<LeanOutcome>;
  email(msg: EmailMessage): Promise<EmailResult>;
  drive: DriveApi;
  preflight(tool: string): Promise<ToolStatus>;
  /** The adopted working-method notes, or null when they cannot be read right now. */
  method?(): Promise<ActiveMethod | null>;
}

export interface RealServicesConfig {
  llm: Llm;
  toolkitSecret: string;
  fetch?: typeof fetch;
  /** Workspace settings, decrypted server-side. */
  settings(): Promise<{ exaKey?: string; leanUrl?: string }>;
  /** A fresh Google access token, or the reason there is none. */
  driveToken(): Promise<{ token?: string; error?: string }>;
  driveRoot: { get(): Promise<string | undefined>; set(id: string): Promise<void> };
  resendKey?: string;
  /** Optional free Stack Exchange app key: raises the shared daily allowance from 300 to 10,000 requests. */
  stackExchangeKey?: string;
  emailTo?: string;
  emailFrom?: string;
  /** Takes one unit of a capped allowance. False means the cap is used up and the call must not be made. */
  take?(kind: "exa" | "email" | "drive"): Promise<boolean>;
}

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reads the result list out of DuckDuckGo's script-free HTML page. Sponsored links are dropped. */
export function parseDdg(html: string): WebResult[] {
  const out: WebResult[] = [];
  for (const part of html.split('class="result__a"').slice(1)) {
    const a = /^[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(part);
    if (!a) continue;
    const href = a[1].replace(/&amp;/g, "&");
    const wrapped = /[?&]uddg=([^&]+)/.exec(href);
    let url = href.startsWith("//") ? `https:${href}` : href;
    if (wrapped) {
      try {
        url = decodeURIComponent(wrapped[1]);
      } catch {
        continue;
      }
    }
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/(y\.js|l\/)/.test(url)) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(part);
    out.push({ title: plainText(a[2]) || url, url, authors: [], text: snippet ? plainText(snippet[1]) : "" });
  }
  return out;
}

/** Maps a zbMATH Open search reply onto bibliographic records. */
export function parseZbmath(json: unknown): Paper[] {
  const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const l = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  return l(o(json).result)
    .map((raw): Paper => {
      const r = o(raw);
      const links = l(r.links).map(o);
      const doi = s(links.find((x) => s(x.type) === "doi")?.identifier) || undefined;
      const arxivId = s(links.find((x) => s(x.type) === "arxiv")?.identifier) || undefined;
      const review = l(r.editorial_contributions).map((e) => s(o(e).text)).find((t) => t.length > 40 && !/contents unavailable/i.test(t)) ?? "";
      return {
        title: plainText(s(o(r.title).title)),
        authors: l(o(r.contributors).authors).map((a) => s(o(a).name)).filter(Boolean).slice(0, 12),
        date: s(r.year) || undefined,
        venue: s(o(r.source).source) || undefined,
        doi,
        arxivId,
        url: s(r.zbmath_url) || (doi ? `https://doi.org/${doi}` : undefined),
        abstract: review.slice(0, 1500),
        via: "zbMATH Open",
      };
    })
    .filter((p) => p.title.length > 0);
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const STANDARD_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", le: "≤", ge: "≥", times: "×" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === "#") {
      const code = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): { title?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = html
    .replace(/<(script|style|noscript|svg|head|nav|footer|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article|\/blockquote|\/pre)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title ? decodeEntities(title).replace(/\s+/g, " ").trim() : undefined, text };
}

const xmlTag = (xml: string, tag: string): string => {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
};

export function parseArxivAtom(xml: string): Paper[] {
  const out: Paper[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const idUrl = xmlTag(e, "id");
    const arxivId = /abs\/([^\s<]+?)(v\d+)?$/.exec(idUrl)?.[1];
    const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((a) => decodeEntities(a[1]).trim());
    const doi = /<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/.exec(e)?.[1]?.trim();
    const journal = /<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/.exec(e)?.[1]?.trim();
    const title = xmlTag(e, "title");
    if (!title || !arxivId) continue;
    out.push({
      title,
      authors,
      date: xmlTag(e, "published").slice(0, 10) || undefined,
      venue: journal ? decodeEntities(journal) : "arXiv",
      doi: doi || undefined,
      arxivId,
      url: `https://arxiv.org/abs/${arxivId}`,
      abstract: xmlTag(e, "summary"),
      via: "arXiv API",
    });
  }
  return out;
}

export function parseCrossref(j: unknown): Paper[] {
  const out: Paper[] = [];
  for (const it of arr(rec(rec(j).message).items) as Rec[]) {
    const title = str(arr(it.title)[0]);
    if (!title) continue;
    const parts = arr(arr(rec(it.issued)["date-parts"])[0]) as number[];
    const date = parts.length ? parts.map((p, i) => (i === 0 ? String(p) : String(p).padStart(2, "0"))).join("-") : undefined;
    out.push({
      title: decodeEntities(title.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
      authors: (arr(it.author) as Rec[]).map((a) => [str(a.given), str(a.family)].filter(Boolean).join(" ") || str(a.name)).filter(Boolean),
      date,
      venue: str(arr(it["container-title"])[0]) || undefined,
      doi: str(it.DOI) || undefined,
      url: str(it.URL) || (it.DOI ? `https://doi.org/${str(it.DOI)}` : undefined),
      abstract: decodeEntities(str(it.abstract).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
      via: "Crossref API",
    });
  }
  return out;
}

/** Reads one entry in the OEIS internal line format (`%S A000045 0,1,1,2,…`), as kept in the official oeisdata mirror. */
export function parseOeisSeq(text: string): OeisEntry | undefined {
  const by: Record<string, string[]> = {};
  let id = "";
  for (const line of text.split(/\r?\n/)) {
    const m = /^%([A-Za-z]) (A\d{6})(?: (.*))?$/.exec(line);
    if (!m) continue;
    id ||= m[2];
    (by[m[1]] ??= []).push((m[3] ?? "").trim());
  }
  if (!id || !by.N?.length) return undefined;
  return {
    id,
    name: by.N[0],
    data: [...(by.S ?? []), ...(by.T ?? []), ...(by.U ?? [])].join("").replace(/,$/, ""),
    comments: (by.C ?? []).slice(0, 8),
    formulas: (by.F ?? []).slice(0, 8),
    references: (by.D ?? []).slice(0, 6),
    url: `https://oeis.org/${id}`,
  };
}

/** The A-numbers named in a query, normalised to six digits, at most four. */
export function oeisIds(query: string): string[] {
  const ids = [...query.matchAll(/\bA(\d{1,6})\b/gi)].map((m) => `A${m[1].padStart(6, "0")}`);
  return [...new Set(ids)].slice(0, 4);
}

/** Seconds Stack Exchange asked us to wait, read from its throttle message; 0 when it is not a throttle reply. */
export function throttleSeconds(message: string): number {
  const m = /more requests available in (\d+) seconds/i.exec(message);
  return m ? Number(m[1]) : 0;
}

// Remembered per server instance, so a throttled address is not hammered (which only lengthens the block).
let seBlockedUntil = 0;

export function parseOeis(j: unknown): OeisEntry[] {
  const list = Array.isArray(j) ? j : arr(rec(j).results);
  return (list as Rec[]).slice(0, 8).map((r) => {
    const id = `A${String(r.number ?? "").padStart(6, "0")}`;
    return {
      id,
      name: str(r.name),
      data: str(r.data),
      comments: (arr(r.comment) as string[]).slice(0, 8).map(String),
      formulas: (arr(r.formula) as string[]).slice(0, 8).map(String),
      references: (arr(r.reference) as string[]).slice(0, 6).map(String),
      url: `https://oeis.org/${id}`,
    };
  });
}

const titleKey = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function dedupePapers(papers: Paper[]): Paper[] {
  const seen = new Map<string, Paper>();
  const out: Paper[] = [];
  for (const p of papers) {
    const keys = [p.doi ? `doi:${p.doi.toLowerCase()}` : "", p.arxivId ? `arxiv:${p.arxivId}` : "", `t:${titleKey(p.title)}`].filter(Boolean);
    const hit = keys.map((k) => seen.get(k)).find(Boolean);
    if (hit) {
      hit.doi ??= p.doi;
      hit.arxivId ??= p.arxivId;
      if (!hit.abstract && p.abstract) hit.abstract = p.abstract;
      for (const k of keys) seen.set(k, hit);
      continue;
    }
    for (const k of keys) seen.set(k, p);
    out.push(p);
  }
  return out;
}

/** Parses the diagnostics a Lean language server published for one file. */
export function summarizeLean(diags: { severity: number; message: string; line: number }[], theoremName: string): Pick<LeanOutcome, "ok" | "errors" | "warnings" | "infos" | "axioms" | "versions"> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  let axioms: string[] | undefined;
  let versions = "";
  for (const d of diags) {
    const line = `line ${d.line + 1}: ${d.message.trim()}`;
    if (d.severity === 1) errors.push(line);
    else if (d.severity === 2) warnings.push(line);
    else {
      infos.push(line);
      const dep = /depends on axioms:\s*\[([^\]]*)\]/.exec(d.message);
      const named = d.message.includes(`'${theoremName}'`) || d.message.includes(theoremName);
      if (dep && named) axioms = dep[1].split(",").map((s) => s.trim()).filter(Boolean);
      else if (named && /does not depend on any axioms/.test(d.message)) axioms = [];
      else if (/^"?\d+\.\d+\.\d+/.test(d.message.trim())) versions = `Lean ${d.message.trim().replace(/"/g, "")}`;
    }
  }
  return { ok: errors.length === 0 && axioms !== undefined, errors, warnings, infos, axioms, versions };
}

export function createServices(cfg: RealServicesConfig): Services {
  const f: typeof fetch = cfg.fetch ?? ((input, init) => fetch(input, init));
  const UA = { "user-agent": "Scholium/1.0 (research workspace)" };

  async function getJson(url: string, init: RequestInit, what: string): Promise<unknown> {
    const res = await f(url, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${what} returned HTTP ${res.status}: ${text.slice(0, 240)}`);
    const j = safeJson<unknown>(text);
    if (j === undefined) throw new Error(`${what} returned a reply that is not JSON: ${text.slice(0, 160)}`);
    return j;
  }

  /**
   * Exa is a paid service with a free allowance, so it is off unless the workspace hands over its own key, which it
   * does only after the user confirmed the Exa account has no payment method, and only within the monthly cap that
   * `take` enforces. Nothing is ever sent through a metered proxy. Returns null when Exa may not be used.
   */
  async function exa(path: "search" | "contents", body: Rec, signal?: AbortSignal): Promise<{ json: Rec; via: string } | null> {
    const { exaKey } = await cfg.settings();
    if (!exaKey) return null;
    if (cfg.take && !(await cfg.take("exa"))) return null;
    const j = await getJson(`https://api.exa.ai/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": exaKey }, body: JSON.stringify(body), signal }, "Exa");
    return { json: rec(j), via: "Exa (your own free-plan key)" };
  }

  // ---- Free, keyless search backends. None of them can bill: there is no account behind the requests. ----
  async function ddg(query: string, n: number, signal?: AbortSignal): Promise<WebResult[]> {
    const res = await f(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { "user-agent": BROWSER_UA, accept: "text/html" }, signal });
    const html = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = parseDdg(html).slice(0, n);
    if (!out.length && /anomaly|challenge|captcha/i.test(html)) throw new Error("asked for a human check");
    return out;
  }

  async function wikipedia(query: string, n: number, signal?: AbortSignal): Promise<WebResult[]> {
    const j = rec(await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${n}&format=json&utf8=1`, { headers: UA, signal }, "Wikipedia"));
    return (arr(rec(j.query).search) as Rec[])
      .map((r): WebResult => ({ title: `${str(r.title)} (Wikipedia)`, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(str(r.title).replace(/ /g, "_"))}`, date: str(r.timestamp).slice(0, 10) || undefined, authors: [], text: plainText(str(r.snippet)) }))
      .filter((r) => r.title.length > 12);
  }

  async function stackExchange(site: string, query: string, n: number, signal?: AbortSignal): Promise<WebResult[]> {
    const wait = Math.ceil((seBlockedUntil - Date.now()) / 1000);
    if (wait > 0) throw new Error(`Stack Exchange is throttling this server's address; it said to wait about ${Math.ceil(wait / 60)} more minutes${cfg.stackExchangeKey ? "" : ". A free Stack Exchange app key (STACKEXCHANGE_KEY) raises the allowance"}.`);
    const key = cfg.stackExchangeKey ? `&key=${encodeURIComponent(cfg.stackExchangeKey)}` : "";
    let j: Rec;
    try {
      j = rec(await getJson(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=${site}&pagesize=${n}${key}`, { headers: UA, signal }, site));
    } catch (e) {
      const s = throttleSeconds(errText(e));
      if (s > 0) seBlockedUntil = Date.now() + s * 1000;
      throw e;
    }
    if (typeof j.backoff === "number" && j.backoff > 0) seBlockedUntil = Date.now() + j.backoff * 1000;
    return (arr(j.items) as Rec[])
      .map((r): WebResult => {
        const at = typeof r.creation_date === "number" ? new Date(r.creation_date * 1000).toISOString().slice(0, 10) : undefined;
        return { title: `${plainText(str(r.title))} (${site})`, url: str(r.link), date: at, authors: [], text: `Question on ${site}; score ${String(r.score ?? "?")}; ${r.is_answered ? "has an accepted or upvoted answer" : "no accepted answer"}. Open the page for the full text.` };
      })
      .filter((r) => r.url);
  }

  async function zbmath(query: string, max: number, signal?: AbortSignal): Promise<Paper[]> {
    const j = rec(await getJson(`https://api.zbmath.org/v1/document/_search?search_string=${encodeURIComponent(query)}&results_per_page=${max}`, { headers: UA, signal }, "zbMATH Open"));
    return parseZbmath(j);
  }

  const toWeb = (r: Rec): WebResult => ({
    title: str(r.title) || str(r.url),
    url: str(r.url),
    date: str(r.publishedDate).slice(0, 10) || undefined,
    authors: str(r.author)
      .split(/,|;| and /)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12),
    text: str(r.text),
  });

  async function webSearch(query: string, opts: { num: number; category?: string }, signal?: AbortSignal) {
    const n = Math.max(1, Math.min(10, opts.num));
    const notes: string[] = [];
    try {
      const body: Rec = { query, numResults: n, type: "auto", contents: { text: { maxCharacters: 6000 } } };
      if (opts.category) body.category = opts.category;
      const paid = await exa("search", body, signal);
      if (paid) {
        const results = (arr(paid.json.results) as Rec[]).map(toWeb).filter((r) => r.url);
        if (results.length) return { results, via: paid.via };
        notes.push("Exa: no results");
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      notes.push(`Exa failed: ${errText(e).slice(0, 80)}`);
    }
    const settle = async (name: string, p: Promise<WebResult[]>): Promise<WebResult[]> => {
      try {
        const r = await p;
        notes.push(`${name}: ${r.length}`);
        return r;
      } catch (e) {
        if (signal?.aborted) throw e;
        notes.push(`${name} failed: ${errText(e).slice(0, 80)}`);
        return [];
      }
    };
    const lists = await Promise.all([
      settle("DuckDuckGo", ddg(query, n, signal)),
      settle("Wikipedia", wikipedia(query, 3, signal)),
      settle("MathOverflow", stackExchange("mathoverflow.net", query, 3, signal)),
      settle("Mathematics Stack Exchange", stackExchange("math.stackexchange.com", query, 2, signal)),
    ]);
    // Interleave so that one backend cannot crowd out the others, then drop repeated addresses.
    const seen = new Set<string>();
    const results: WebResult[] = [];
    for (let i = 0; i < n; i++) {
      for (const list of lists) {
        const r = list[i];
        if (!r || seen.has(r.url)) continue;
        seen.add(r.url);
        results.push(r);
      }
    }
    if (!results.length) throw new Error(`No free search backend returned results (${notes.join("; ")}).`);
    return { results: results.slice(0, n + 4), via: `free keyless search (${notes.join(" · ")})` };
  }

  async function crossref(query: string, max: number, signal?: AbortSignal): Promise<Paper[]> {
    const u = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${max}&select=DOI,title,author,issued,container-title,URL,type,abstract`;
    return parseCrossref(await getJson(u, { headers: UA, signal }, "Crossref"));
  }

  async function arxiv(query: string, max: number, signal?: AbortSignal): Promise<Paper[]> {
    const terms = keyTerms(query).slice(0, 6);
    if (!terms.length) return [];
    const q = terms.map((t) => `all:${t}`).join("+AND+");
    const res = await f(`https://export.arxiv.org/api/query?search_query=${q}&start=0&max_results=${max}&sortBy=relevance`, { headers: UA, signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`arXiv returned HTTP ${res.status}: ${text.slice(0, 200)}`);
    return parseArxivAtom(text);
  }

  async function literature(query: string, max: number, signal?: AbortSignal) {
    const n = Math.max(1, Math.min(10, max));
    const backends: Record<string, string> = {};
    const settle = async (name: string, p: Promise<Paper[]>): Promise<Paper[]> => {
      try {
        const r = await p;
        backends[name] = `ok (${r.length})`;
        return r;
      } catch (e) {
        if (signal?.aborted) throw e;
        backends[name] = `failed: ${errText(e).slice(0, 200)}`;
        return [];
      }
    };
    const [a, b, c] = await Promise.all([settle("Crossref", crossref(query, n, signal)), settle("arXiv", arxiv(query, n, signal)), settle("zbMATH Open", zbmath(query, n, signal))]);
    // Interleave so that no single backend crowds out the others.
    const mixed: Paper[] = [];
    for (let i = 0; i < n; i++) for (const list of [b, a, c]) if (list[i]) mixed.push(list[i]);
    return { papers: dedupePapers(mixed).slice(0, n * 2), backends };
  }

  async function fetchDocument(url: string, signal?: AbortSignal): Promise<FetchedDoc> {
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(url)) throw new Error("Only public http(s) addresses can be retrieved.");
    const problems: string[] = [];
    // 1. Straight from the publisher.
    try {
      const res = await f(url, { headers: { ...UA, accept: "text/html,text/plain,application/json,application/xhtml+xml" }, redirect: "follow", signal });
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok) problems.push(`direct fetch returned HTTP ${res.status}`);
      else if (/pdf|octet-stream/i.test(ct)) problems.push("the address serves a PDF, which cannot be parsed directly");
      else {
        const raw = (await res.text()).slice(0, 1_500_000);
        if (/html/i.test(ct) || /^\s*<(!doctype|html)/i.test(raw)) {
          const { title, text } = htmlToText(raw);
          if (text.length >= 200) return { title, text: text.slice(0, 400000), via: "direct fetch", complete: text.length <= 400000 };
          problems.push("the page itself has almost no text (it may need JavaScript)");
        } else if (raw.trim().length > 0) return { text: raw.slice(0, 400000), via: "direct fetch", complete: raw.length <= 400000 };
        else problems.push("the address returned an empty reply");
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      problems.push(`direct fetch failed: ${errText(e).slice(0, 160)}`);
    }
    // 2. A free public reader that also extracts text from PDFs. Labelled, because a third party produced the text.
    try {
      const res = await f(`https://r.jina.ai/${url}`, { headers: { ...UA, accept: "text/plain" }, signal });
      const text = (await res.text()).slice(0, 400_001);
      if (res.ok && text.length > 200) {
        const title = /^Title:\s*(.+)$/m.exec(text.slice(0, 2000))?.[1]?.trim();
        return { title, text: text.slice(0, 400000), via: "Jina Reader (free public endpoint; text extracted by a third party)", complete: text.length <= 400000 };
      }
      problems.push(res.ok ? "Jina Reader returned no text" : `Jina Reader returned HTTP ${res.status}`);
    } catch (e) {
      if (signal?.aborted) throw e;
      problems.push(`Jina Reader failed: ${errText(e).slice(0, 160)}`);
    }
    // 3. Exa, only when the workspace allows it (see `exa`).
    try {
      const paid = await exa("contents", { urls: [url], text: { maxCharacters: 400000 } }, signal);
      if (paid) {
        const r = rec(arr(paid.json.results)[0]);
        const text = str(r.text);
        if (text.length > 200) return { title: str(r.title) || undefined, text, via: paid.via, complete: text.length < 399000 };
        problems.push("Exa returned no text for this address");
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      problems.push(`Exa failed: ${errText(e).slice(0, 160)}`);
    }
    throw new Error(`Could not retrieve the document: ${problems.join("; ")}. Ask the user to upload it.`);
  }

  async function oeis(query: string, signal?: AbortSignal): Promise<OeisEntry[]> {
    try {
      return parseOeis(await getJson(`https://oeis.org/search?q=${encodeURIComponent(query)}&fmt=json`, { headers: UA, signal }, "OEIS"));
    } catch (e) {
      if (signal?.aborted) throw e;
      // oeis.org sometimes blocks shared server addresses. Entries named by A-number can still be read from the
      // official OEIS data mirror; a search by terms cannot, so that keeps the real error.
      const ids = oeisIds(query);
      if (!ids.length) throw new Error(`${errText(e).slice(0, 200)}. Searching by terms is unavailable while oeis.org refuses this server; looking up a sequence by its A-number still works.`);
      const found = await Promise.all(ids.map((id) => oeisMirror(id, signal).catch(() => undefined)));
      const out = found.filter((x): x is OeisEntry => x !== undefined);
      if (!out.length) throw e;
      return out;
    }
  }

  async function oeisMirror(id: string, signal?: AbortSignal): Promise<OeisEntry | undefined> {
    const res = await f(`https://raw.githubusercontent.com/oeis/oeisdata/main/seq/${id.slice(0, 4)}/${id}.seq`, { headers: UA, signal });
    if (!res.ok) return undefined;
    return parseOeisSeq(await res.text());
  }

  async function sage(code: string, signal?: AbortSignal) {
    const res = await f("https://sagecell.sagemath.org/service", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...UA },
      body: `code=${encodeURIComponent(code)}`,
      signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, stdout: "", error: `SageMathCell returned HTTP ${res.status}: ${text.slice(0, 200)}` };
    const j = safeJson<Rec>(text);
    if (!j) return { ok: false, stdout: "", error: `SageMathCell returned a reply that is not JSON: ${text.slice(0, 200)}` };
    const exec = rec(j.execute_reply);
    if (j.success === false || exec.status === "error") {
      return { ok: false, stdout: str(j.stdout), error: `${str(exec.ename) || "error"}: ${str(exec.evalue) || "execution failed"}` };
    }
    return { ok: true, stdout: str(j.stdout) };
  }

  /** Checks one file against a lean4web-compatible server (Lean language server over WebSocket). */
  async function lean(source: string, theoremName: string, signal?: AbortSignal): Promise<LeanOutcome> {
    const empty = { ok: false, errors: [], warnings: [], infos: [], versions: "", log: "" };
    const { leanUrl } = await cfg.settings();
    if (!leanUrl) return { ...empty, infraError: "No Lean server is configured for this workspace." };
    const text = `${source.trimEnd()}\n\n#print axioms ${theoremName}\n#eval Lean.versionString\n`;
    const uri = "file:///LeanProject/Scholium.lean";
    return new Promise<LeanOutcome>((resolve) => {
      let ws: WebSocket;
      const diags = new Map<string, { severity: number; message: string; line: number }>();
      const log: string[] = [];
      let finished = false;
      let sawProgress = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (infraError?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(hard);
        if (settleTimer) clearTimeout(settleTimer);
        try {
          ws.close(1000, "done");
        } catch {
          /* already closed */
        }
        const s = summarizeLean([...diags.values()], theoremName);
        resolve({ ...s, ok: s.ok && !infraError, log: log.join("\n").slice(0, 6000), infraError });
      };
      const hard = setTimeout(() => finish("The Lean server did not finish checking within 150 seconds."), 150000);
      signal?.addEventListener("abort", () => finish("Cancelled."));
      try {
        ws = new WebSocket(leanUrl);
      } catch (e) {
        clearTimeout(hard);
        resolve({ ...empty, infraError: `Could not open the Lean server connection: ${errText(e)}` });
        return;
      }
      const send = (m: Rec) => ws.send(JSON.stringify({ jsonrpc: "2.0", ...m }));
      ws.addEventListener("open", () => {
        send({ id: 0, method: "initialize", params: { processId: null, rootUri: null, capabilities: { textDocument: { publishDiagnostics: {} } } } });
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        const m = safeJson<Rec>(typeof ev.data === "string" ? ev.data : "");
        if (!m) return;
        if (m.id === 0 && m.result) {
          send({ method: "initialized", params: {} });
          send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "lean4", version: 1, text } } });
          return;
        }
        if (m.id !== undefined && m.method) {
          // Server-to-client request; acknowledge so the server does not stall.
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: null }));
          return;
        }
        const p = rec(m.params);
        if (m.method === "textDocument/publishDiagnostics") {
          diags.clear();
          for (const d of arr(p.diagnostics) as Rec[]) {
            const line = Number(rec(rec(d.range).start).line ?? 0);
            const message = str(d.message);
            const severity = Number(d.severity ?? 3);
            diags.set(`${line}:${severity}:${message}`, { severity, message, line });
            log.push(`${severity === 1 ? "error" : severity === 2 ? "warning" : "info"} @${line + 1}: ${message}`);
          }
        } else if (m.method === "$/lean/fileProgress") {
          const processing = arr(p.processing);
          if (processing.length) sawProgress = true;
          if (settleTimer) clearTimeout(settleTimer);
          if (sawProgress && processing.length === 0) settleTimer = setTimeout(() => finish(), 2500);
        }
      });
      ws.addEventListener("error", () => finish("The connection to the Lean server failed (the server refused it or is unreachable)."));
      ws.addEventListener("close", (ev: CloseEvent) => finish(`The Lean server closed the connection before the check finished (code ${ev.code}).`));
    });
  }

  async function email(msg: EmailMessage): Promise<EmailResult> {
    const to = cfg.emailTo ?? "";
    if (!to) return { status: "skipped", detail: "No alert recipient is configured (ALERT_EMAIL_TO).", to };
    if (!cfg.resendKey) return { status: "skipped", detail: "Email delivery is not configured yet: RESEND_API_KEY is missing.", to };
    try {
      const res = await f("https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.resendKey}` },
        body: JSON.stringify({ from: cfg.emailFrom || "Scholium <onboarding@resend.dev>", to: [to], subject: msg.subject, text: msg.text, html: msg.html }),
      });
      const text = await res.text();
      if (!res.ok) return { status: "failed", detail: `Resend returned HTTP ${res.status}: ${str(rec(safeJson(text)).message) || text.slice(0, 200)}`, to };
      return { status: "sent", detail: `Resend id ${str(rec(safeJson(text)).id) || "unknown"}`, to };
    } catch (e) {
      return { status: "failed", detail: `Could not reach Resend: ${errText(e)}`, to };
    }
  }

  async function driveFetch(url: string, init: RequestInit): Promise<Rec> {
    const t = await cfg.driveToken();
    if (!t.token) throw new Error(t.error || "Google Drive is not connected.");
    const res = await f(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${t.token}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Google Drive returned HTTP ${res.status}: ${str(rec(rec(safeJson(text)).error).message) || text.slice(0, 200)}`);
    return rec(safeJson(text));
  }

  const FOLDER = "application/vnd.google-apps.folder";
  const createFolder = async (name: string, parent?: string): Promise<string> => {
    const j = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }),
    });
    return str(j.id);
  };

  const drive: DriveApi = {
    async status() {
      const t = await cfg.driveToken();
      return t.token ? { connected: true, detail: "Connected." } : { connected: false, detail: t.error || "Google Drive is not connected." };
    },
    async ensureRunFolder(title: string) {
      let root = await cfg.driveRoot.get();
      if (root) {
        // The user may have deleted the folder; check it still exists and is not in the bin.
        try {
          const j = await driveFetch(`https://www.googleapis.com/drive/v3/files/${root}?fields=id,trashed`, { method: "GET" });
          if (j.trashed) root = undefined;
        } catch {
          root = undefined;
        }
      }
      if (!root) {
        root = await createFolder("Scholium");
        await cfg.driveRoot.set(root);
      }
      const id = await createFolder(title.slice(0, 120) || "Untitled run", root);
      return { id, url: `https://drive.google.com/drive/folders/${id}` };
    },
    async putFile(folderId, name, mime, content, existingFileId) {
      if (existingFileId) {
        const j = await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=media&fields=id`, {
          method: "PATCH",
          headers: { "content-type": mime },
          body: content,
        });
        return str(j.id) || existingFileId;
      }
      const boundary = `scholium${Math.random().toString(36).slice(2)}`;
      const body = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n${content}\r\n--${boundary}--`;
      const j = await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
        method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body,
      });
      return str(j.id);
    },
  };

  async function preflight(tool: string): Promise<ToolStatus> {
    const at = Date.now();
    const done = (ok: boolean, detail: string): ToolStatus => ({ ok, detail, checkedAt: at });
    try {
      if (tool === "web") {
        const r = await webSearch("Riemann hypothesis", { num: 1 });
        return done(r.results.length > 0, r.results.length ? r.via : `${r.via} returned no results`);
      }
      if (tool === "literature") {
        const r = await literature("prime number theorem", 1);
        const ok = Object.values(r.backends).some((v) => v.startsWith("ok"));
        return done(ok, Object.entries(r.backends).map(([k, v]) => `${k}: ${v}`).join(" · "));
      }
      if (tool === "oeis") {
        try {
          const r = await oeis("1,1,2,3,5,8,13,21");
          return done(r.length > 0, r.length ? `OEIS answered (${r[0].id})` : "OEIS returned no results");
        } catch (e) {
          const m = await oeisMirror("A000045").catch(() => undefined);
          if (!m) throw e;
          return done(true, `Partly working: sequences can be looked up by A-number through the official OEIS data mirror (${m.id} read), but searching by terms is unavailable because ${errText(e).slice(0, 140)}`);
        }
      }
      if (tool === "sage") {
        const r = await sage("print(factorial(5))");
        return done(r.ok && r.stdout.includes("120"), r.ok ? "SageMathCell answered" : r.error || "SageMathCell did not answer");
      }
      if (tool === "lean") {
        const s = await cfg.settings();
        if (!s.leanUrl) return done(false, "No Lean server is configured. Add a lean4web-compatible server address in Settings to enable formal checks.");
        const r = await lean("theorem scholium_ping : 1 + 1 = 2 := rfl", "scholium_ping");
        return done(r.ok, r.ok ? `Lean server answered${r.versions ? ` (${r.versions})` : ""}` : r.infraError || r.errors[0] || "The Lean server did not report the axiom check.");
      }
      if (tool === "email") {
        if (!cfg.emailTo) return done(false, "No alert recipient is configured.");
        return done(Boolean(cfg.resendKey), cfg.resendKey ? "Resend key is set" : "RESEND_API_KEY is missing, so no email can be sent yet.");
      }
      if (tool === "drive") {
        const s = await drive.status();
        return done(s.connected, s.detail);
      }
      if (tool === "search:ddg") {
        const r = await ddg("Riemann zeta function zeros", 3);
        return done(r.length > 0, r.length ? `DuckDuckGo answered with ${r.length} results (first: ${r[0].url})` : "DuckDuckGo returned a page with no results that could be read");
      }
      if (tool === "search:wikipedia") {
        const r = await wikipedia("Riemann zeta function", 2);
        return done(r.length > 0, r.length ? `Wikipedia answered (${r[0].url})` : "Wikipedia returned no results");
      }
      if (tool === "search:stackexchange") {
        const r = await stackExchange("mathoverflow.net", "Riemann hypothesis", 2);
        return done(r.length > 0, r.length ? `MathOverflow answered (${r[0].url})` : "MathOverflow returned no results");
      }
      if (tool === "search:zbmath") {
        const r = await zbmath("prime number theorem", 2);
        return done(r.length > 0, r.length ? `zbMATH Open answered (${r[0].title.slice(0, 80)}${r[0].url ? `, ${r[0].url}` : ""})` : "zbMATH Open returned no results");
      }
      if (tool === "reader:jina") {
        const res = await f("https://r.jina.ai/https://www.claymath.org/millennium/riemann-hypothesis/", { headers: { ...UA, accept: "text/plain" } });
        const text = await res.text();
        return done(res.ok && text.length > 200, res.ok ? `Jina Reader answered with ${text.length.toLocaleString("en-US")} characters` : `Jina Reader returned HTTP ${res.status}`);
      }
      if (tool === "lmfdb") {
        const res = await f("https://www.lmfdb.org/api/ec_curvedata/?lmfdb_label=11.a1&_format=json", { headers: UA });
        const text = await res.text();
        const row = rec(arr(rec(safeJson<unknown>(text)).data)[0]);
        const ok = res.ok && str(row.lmfdb_label) === "11.a1";
        return done(ok, ok ? `LMFDB answered: curve 11.a1, conductor ${String(row.conductor)}, rank ${String(row.rank)} (https://www.lmfdb.org/EllipticCurve/Q/11/a/1)` : `LMFDB returned HTTP ${res.status}: ${text.slice(0, 120)}`);
      }
      return done(true, "Checked on first use.");
    } catch (e) {
      return done(false, errText(e).slice(0, 300));
    }
  }

  return { now: () => Date.now(), llm: cfg.llm, webSearch, literature, fetchDocument, oeis, sage, lean, email, drive, preflight };
}
