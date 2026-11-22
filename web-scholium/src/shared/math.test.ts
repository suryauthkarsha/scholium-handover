import katex from "katex";
import { describe, expect, it } from "vitest";

import { escapeCurrency, mathSegments, normalizeMath, tailText } from "./math";

describe("normalizeMath", () => {
  it("turns \\( … \\) and \\[ … \\] into dollar forms", () => {
    expect(normalizeMath("Let \\(n \\ge 2\\) be given.")).toBe("Let $n \\ge 2$ be given.");
    expect(normalizeMath("So\n\\[\n a^2 + b^2 = c^2\n\\]\nholds.")).toBe("So\n$$\na^2 + b^2 = c^2\n$$\nholds.");
  });

  it("puts the fences of a display on their own lines, keeping the indentation", () => {
    expect(normalizeMath("$$x = 1$$")).toBe("$$\nx = 1\n$$");
    expect(normalizeMath("$$ a = b\n  + c $$")).toBe("$$\na = b\n+ c\n$$");
    expect(normalizeMath("- item\n\n  $$x = 1$$")).toBe("- item\n\n  $$\n  x = 1\n  $$");
    expect(normalizeMath("$$\nx = 1\n$$")).toBe("$$\nx = 1\n$$");
  });

  it("keeps a display written inside a sentence or list item in place, in display style", () => {
    expect(normalizeMath("- we get $$x = 1$$ here")).toBe("- we get $\\displaystyle x = 1$ here");
  });

  it("wraps a bare display environment and leaves one already in a formula alone", () => {
    expect(normalizeMath("Then\n\\begin{align}\na &= b\n\\end{align}\ndone")).toBe("Then\n$$\n\\begin{align}\na &= b\n\\end{align}\n$$\ndone");
    const inside = "$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$";
    expect(normalizeMath(inside)).toBe(inside);
    expect(normalizeMath("$f(x) = \\begin{cases} 1 \\\\ 0 \\end{cases}$")).toBe("$f(x) = \\begin{cases} 1 \\\\ 0 \\end{cases}$");
  });

  it("never touches code", () => {
    const code = "Use `\\(x\\)` or\n```\n$$x$$ costs $5\n```";
    expect(normalizeMath(code)).toBe(code);
  });

  it("treats money as money and formulas that start with a digit as formulas", () => {
    expect(escapeCurrency("Spent $1.20 of $25.00 so far.")).toBe("Spent \\$1.20 of \\$25.00 so far.");
    expect(escapeCurrency("It costs $5 where $n$ is small.")).toBe("It costs \\$5 where $n$ is small.");
    expect(escapeCurrency("The limit is $5,000.")).toBe("The limit is \\$5,000.");
    expect(escapeCurrency("Since $2^n$ grows and $3 \\le n$, and $2, 3, 5$ are prime.")).toBe("Since $2^n$ grows and $3 \\le n$, and $2, 3, 5$ are prime.");
    expect(escapeCurrency("Already \\$5 here.")).toBe("Already \\$5 here.");
  });

  it("produces formulas KaTeX accepts", () => {
    const out = normalizeMath("\\[\\sum_{k=1}^n k = \\frac{n(n+1)}{2}\\]");
    const body = out.replace(/\$\$/g, "").trim();
    expect(() => katex.renderToString(body, { throwOnError: true, displayMode: true })).not.toThrow();
    expect(() => katex.renderToString("\\begin{align}a &= b\\\\ c &= d\\end{align}", { throwOnError: true, displayMode: true })).not.toThrow();
  });
});

describe("mathSegments", () => {
  it("splits a line into words and formulas", () => {
    expect(mathSegments("Prove $a^2 \\ge 0$ for real \\(a\\).")).toEqual([
      { math: false, text: "Prove " },
      { math: true, text: "a^2 \\ge 0" },
      { math: false, text: " for real " },
      { math: true, text: "a" },
      { math: false, text: "." },
    ]);
  });

  it("shows money plainly", () => {
    expect(mathSegments("Spent $1.20 of $25.00")).toEqual([{ math: false, text: "Spent $1.20 of $25.00" }]);
  });

  it("drops a formula that shortening cut in half", () => {
    expect(mathSegments("Show that $\\sum_{k=1}^{n} \\frac{1}{k…")).toEqual([{ math: false, text: "Show that …" }]);
  });

  it("does not pair dollar signs across a blank line", () => {
    expect(mathSegments("ends $x\n\nstarts y$ z").some((s) => s.math)).toBe(false);
  });

  it("returns plain text untouched", () => {
    expect(mathSegments("No formulas here.")).toEqual([{ math: false, text: "No formulas here." }]);
  });
});

describe("tailText", () => {
  it("starts at a paragraph break", () => {
    const t = `${"a".repeat(50)} $x +\n\ny$ second paragraph ${"b".repeat(40)}`;
    expect(tailText(t, 70).startsWith("y$ second")).toBe(true);
    expect(tailText("short", 70)).toBe("short");
  });
});
