// Renders real examples of how models write formulas and checks that each one comes out typeset, not as raw symbols.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown, MathText } from "./Markdown";

const html = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);
const count = (s: string, needle: string): number => s.split(needle).length - 1;

describe("formulas in rendered text", () => {
  it.each([
    ["dollar display on its own lines", "Then\n\n$$\n\\sum_{k=1}^n k = \\frac{n(n+1)}{2}\n$$\n\nholds."],
    ["dollar display on one line", "Then\n\n$$\\sum_{k=1}^n k = \\frac{n(n+1)}{2}$$\n\nholds."],
    ["display opened and closed beside the formula", "Then\n$$ a = b\n+ c $$\nholds."],
    ["bracket display", "Then\n\\[\n\\int_0^1 x^2\\,dx = \\tfrac13\n\\]\nholds."],
    ["bare align environment", "Then\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\nholds."],
    ["display inside a list item", "1. First\n\n   $$x^2 + y^2 = z^2$$\n\n2. Second"],
  ])("%s is a display", (_name, text) => {
    const out = html(text);
    expect(count(out, "katex-display")).toBe(1);
    expect(out).not.toContain("$$");
    expect(out).not.toContain("katex-error");
  });

  it("typesets inline formulas written either way", () => {
    const out = html("Let \\(n \\ge 2\\) and $p \\mid n$ with p_1 and a_b outside.");
    expect(count(out, 'class="katex"')).toBe(2);
    expect(out).not.toContain("\\(");
  });

  it("shows money as money", () => {
    const out = html("Spent $1.20 of $25.00 so far, and $2^n$ grows.");
    expect(out).toContain("$1.20 of $25.00");
    expect(count(out, 'class="katex"')).toBe(1);
  });

  it("leaves code alone", () => {
    const out = html("Run `\\(x\\)` and\n\n```\n$$x$$\n```");
    expect(out).not.toContain("katex");
  });

  it("typesets formulas in plain one-line text", () => {
    const out = renderToStaticMarkup(<MathText text={"Prove $a^2 \\ge 0$ for \\(a \\in \\mathbb{R}\\), budget $5"} />);
    expect(count(out, 'class="katex"')).toBe(2);
    expect(out).toContain("budget $5");
  });
});
