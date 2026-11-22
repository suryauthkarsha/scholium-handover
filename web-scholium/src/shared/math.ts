// One place that decides what counts as mathematics in model-written text, so every view and export agrees.
// Models write formulas in several ways ($…$, \( … \), \[ … \], $$ … $$ on one line or many, bare \begin{align});
// the Markdown reader only understands some of them. This turns all of them into the forms it does understand,
// and keeps money amounts such as "$25" from being read as formulas. Code is never touched.

const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;
const ENVS = "equation|align|aligned|alignat|gather|gathered|multline|split|cases|array|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|smallmatrix|CD";
const BARE_ENV = new RegExp(String.raw`\\begin\{(${ENVS})(\*?)\}[\s\S]*?\\end\{\1\2\}`, "g");

const escaped = (s: string, i: number): boolean => {
  let n = 0;
  for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) n++;
  return n % 2 === 1;
};

/** Index of the next lone, unescaped dollar sign on the line, or -1. */
function nextDollar(line: string, from: number): number {
  for (let i = from; i < line.length; i++) if (line[i] === "$" && !escaped(line, i)) return i;
  return -1;
}

/**
 * Escapes dollar signs that are money ("$25", "$1.20 of $5,000") and leaves formulas that begin with a digit
 * ("$2^n$", "$3 \le n$") alone. A dollar sign before a digit is a formula only when a closing dollar sign follows
 * on the same line: one that ends a word and is not itself the start of something.
 */
export function escapeCurrency(line: string): string {
  if (!/\$\d/.test(line)) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c !== "$" || escaped(line, i)) {
      out += c;
      i++;
      continue;
    }
    if (line[i + 1] === "$") {
      const end = line.indexOf("$$", i + 2);
      const stop = end < 0 ? line.length : end + 2;
      out += line.slice(i, stop);
      i = stop;
      continue;
    }
    const q = nextDollar(line, i + 1);
    const closes = q > i + 1 && !/\s/.test(line[q - 1]) && !/[A-Za-z0-9\\{(]/.test(line[q + 1] ?? "");
    if (/\d/.test(line[i + 1] ?? "") && !closes) {
      out += "\\$";
      i++;
      continue;
    }
    if (q < 0) {
      out += line.slice(i);
      break;
    }
    out += line.slice(i, q + 1);
    i = q + 1;
  }
  return out;
}

/** True when the position sits inside an open $…$ or $$…$$ (an odd number of delimiters before it). */
function insideMath(s: string, at: number): boolean {
  let open = false;
  for (let i = 0; i < at; i++) {
    if (s[i] !== "$" || escaped(s, i)) continue;
    if (s[i + 1] === "$") i++;
    open = !open;
  }
  return open;
}

function delimiters(part: string): string {
  let s = part;
  if (s.includes("$")) s = s.split("\n").map(escapeCurrency).join("\n");
  if (s.includes("\\[")) s = s.replace(/(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g, (_m, body: string) => `$$${body.trim()}$$`);
  if (s.includes("\\(")) s = s.replace(/(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)/g, (_m, body: string) => `$${body.trim().replace(/\s*\n\s*/g, " ")}$`);
  return s;
}

function prepare(part: string): string {
  let s = delimiters(part);
  // A display environment written with no delimiters at all.
  if (s.includes("\\begin{")) {
    s = s.replace(BARE_ENV, (m, _env: string, _star: string, at: number, whole: string) => (insideMath(whole, at) ? m : `$$${m.replace(/\\(begin|end)\{multline(\*?)\}/g, "\\$1{gather$2}")}$$`));
  }
  // $$ … $$: alone on its lines it becomes a display block with the fences on their own lines (the only form the
  // reader shows as a display); inside a sentence or a list item it becomes inline mathematics in display style.
  if (s.includes("$$")) {
    s = s.replace(/([ \t]*)\$\$([\s\S]+?)\$\$/g, (m, lead: string, body: string, at: number, whole: string) => {
      const b = body.trim();
      if (!b) return m;
      const end = at + m.length;
      const eol = whole.indexOf("\n", end);
      const alone = (at === 0 || whole[at - 1] === "\n") && !whole.slice(end, eol < 0 ? whole.length : eol).trim();
      if (alone) {
        return `${lead}$$\n${b
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => lead + l.trim())
          .join("\n")}\n${lead}$$`;
      }
      return `${lead}$\\displaystyle ${b.replace(/\s*\n\s*/g, " ")}$`;
    });
  }
  return s;
}

/** Rewrites every way of writing a formula into the dollar-sign forms the Markdown reader understands. */
export function normalizeMath(src: string): string {
  if (!src || (!src.includes("$") && !src.includes("\\"))) return src;
  return src
    .split(CODE)
    .map((part, i) => (i % 2 ? part : prepare(part)))
    .join("");
}

export interface Segment {
  math: boolean;
  text: string;
}

const INLINE = /\$\$([^$]+?)\$\$|\$((?:\\[\s\S]|[^$\\\n]|\n(?!\s*\n))+?)\$/g;

/**
 * Splits a plain line of text (a title, a one-line summary, text still being written) into ordinary text and
 * formulas. Only complete formulas are taken; a formula cut off by shortening is dropped rather than shown as
 * raw symbols.
 */
export function mathSegments(src: string): Segment[] {
  if (!src) return [];
  if (!src.includes("$") && !src.includes("\\(") && !src.includes("\\[")) return [{ math: false, text: src }];
  let s = delimiters(src);
  const out: Segment[] = [];
  const plain = (t: string): void => {
    if (t) out.push({ math: false, text: t.replace(/\\\$/g, "$") });
  };
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (escaped(s, at)) continue;
    const body = (m[1] ?? m[2] ?? "").trim();
    if (!body) continue;
    plain(s.slice(last, at));
    out.push({ math: true, text: body });
    last = at + m[0].length;
  }
  let rest = s.slice(last);
  // A formula that shortening cut in half: keep the words before it.
  const open = nextDollar(rest, 0);
  if (open >= 0 && /…\s*$/.test(rest)) rest = `${rest.slice(0, open).trimEnd()} …`;
  plain(rest);
  s = "";
  return out;
}

/** The end of a long text, started at a paragraph or line break so that it never begins inside a formula. */
export function tailText(text: string, n: number): string {
  if (text.length <= n) return text;
  const t = text.slice(-n);
  const para = t.indexOf("\n\n");
  if (para >= 0 && para < n * 0.6) return t.slice(para + 2);
  const line = t.indexOf("\n");
  return line >= 0 && line < n * 0.6 ? t.slice(line + 1) : t;
}
