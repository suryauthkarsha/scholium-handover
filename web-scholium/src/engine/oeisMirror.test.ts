import { describe, expect, it } from "vitest";
import { createServices, oeisIds, parseOeisSeq, throttleSeconds } from "./services";

const SEQ = `%I A000045 M0692 N0256
%S A000045 0,1,1,2,3,5,8,13,21,34,
%T A000045 55,89,144
%N A000045 Fibonacci numbers: F(n) = F(n-1) + F(n-2) with F(0) = 0 and F(1) = 1.
%C A000045 Also sometimes called Lamé's sequence.
%D A000045 A. T. Benjamin and J. J. Quinn, Proofs that really count.
%F A000045 G.f.: x / (1 - x - x^2).
`;

const services = (fetchFn: typeof fetch) =>
  createServices({
    llm: (async () => {
      throw new Error("no model calls");
    }) as never,
    toolkitSecret: "",
    fetch: fetchFn,
    settings: async () => ({}),
    driveToken: async () => ({ error: "not used" }),
    driveRoot: { get: async () => undefined, set: async () => undefined },
  });

describe("OEIS mirror fallback", () => {
  it("reads an entry in the internal line format", () => {
    const e = parseOeisSeq(SEQ);
    expect(e?.id).toBe("A000045");
    expect(e?.name).toMatch(/^Fibonacci numbers/);
    expect(e?.data).toBe("0,1,1,2,3,5,8,13,21,34,55,89,144");
    expect(e?.formulas).toEqual(["G.f.: x / (1 - x - x^2)."]);
    expect(e?.url).toBe("https://oeis.org/A000045");
  });

  it("returns nothing for text that is not an entry", () => {
    expect(parseOeisSeq("<html>blocked</html>")).toBeUndefined();
  });

  it("finds A-numbers in a query", () => {
    expect(oeisIds("compare A45 with a000108 and A000045")).toEqual(["A000045", "A000108"]);
    expect(oeisIds("1,1,2,3,5,8")).toEqual([]);
  });

  it("uses the mirror for an A-number when oeis.org refuses", async () => {
    const s = services((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://oeis.org/")) return new Response("blocked", { status: 429 });
      expect(url).toBe("https://raw.githubusercontent.com/oeis/oeisdata/main/seq/A000/A000045.seq");
      return new Response(SEQ, { status: 200 });
    }) as typeof fetch);
    const r = await s.oeis("A000045");
    expect(r.map((x) => x.id)).toEqual(["A000045"]);
  });

  it("keeps the real error for a search by terms", async () => {
    const s = services((async () => new Response("blocked", { status: 429 })) as typeof fetch);
    await expect(s.oeis("1,1,2,3,5,8")).rejects.toThrow(/HTTP 429.*Searching by terms is unavailable/s);
  });
});

describe("Stack Exchange throttle", () => {
  it("reads the wait from the throttle message", () => {
    expect(throttleSeconds("too many requests from this IP, more requests available in 81088 seconds")).toBe(81088);
    expect(throttleSeconds("HTTP 500")).toBe(0);
  });
});
