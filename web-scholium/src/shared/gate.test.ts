import { describe, expect, it } from "vitest";

import { ALLOWED_EMAIL, emailAllowed, routeAccess, seal, signDriveState, signTicket, timingSafeEqual, unseal, verifyDriveState, verifyTicket } from "./gate";

const SECRET = "unit-test-secret-0123456789";

describe("allowed account", () => {
  it("matches the one address and nothing that merely resembles it", () => {
    expect(emailAllowed(ALLOWED_EMAIL)).toBe(true);
    expect(emailAllowed(ALLOWED_EMAIL.toUpperCase())).toBe(true);
    const bad: unknown[] = [
      "",
      " ",
      `${ALLOWED_EMAIL} `,
      ` ${ALLOWED_EMAIL}`,
      `${ALLOWED_EMAIL}\n`,
      ALLOWED_EMAIL.replace("@", "+x@"),
      ALLOWED_EMAIL.replace("surya", "surya."),
      ALLOWED_EMAIL.replace("gmail.com", "gmail.co"),
      ALLOWED_EMAIL.replace("gmail.com", "googlemail.com"),
      ALLOWED_EMAIL.replace("a", "\u0430"),
      ALLOWED_EMAIL.replace("k", "\u212a"),
      `x${ALLOWED_EMAIL}`,
      `${ALLOWED_EMAIL}.example.org`,
      null,
      undefined,
      42,
      [ALLOWED_EMAIL],
      { email: ALLOWED_EMAIL },
    ];
    for (const b of bad) expect(emailAllowed(b), JSON.stringify(b)).toBe(false);
  });

  it("compares strings without an early exit on length or content", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("route access", () => {
  it("opens exactly two routes and tickets exactly one", () => {
    const id = "a1".repeat(10);
    expect(routeAccess("GET", "/api/health")).toBe("public");
    expect(routeAccess("GET", "/api/drive/callback")).toBe("public");
    expect(routeAccess("GET", `/api/runs/${id}/ws`)).toBe("ticket");
    const rest: [string, string][] = [
      ["POST", "/api/health"],
      ["GET", "/api/health/x"],
      ["GET", "/api/healthz"],
      ["POST", "/api/drive/callback"],
      ["GET", "/api/drive/start"],
      ["POST", `/api/runs/${id}/ws`],
      ["GET", `/api/runs/${id}/ws/x`],
      ["GET", `/api/runs/${id}`],
      ["GET", `/api/runs/${id}/uploads/U1/file`],
      ["GET", `/api/runs/${id}/export`],
      ["GET", "/api/runs/SHORT/ws"],
      ["GET", "/api/me"],
      ["GET", "/api/workspace"],
      ["DELETE", `/api/runs/${id}`],
    ];
    for (const [m, p] of rest) expect(routeAccess(m, p), `${m} ${p}`).toBe("protected");
  });
});

describe("sealed tokens", () => {
  it("round-trips, expires, and rejects tampering and reuse for another purpose", async () => {
    const t = await seal(SECRET, "one", ["alpha", "beta"], 5000);
    expect(await unseal(SECRET, "one", t, 2, 4000)).toEqual({ ok: true, parts: ["alpha", "beta"], exp: 5000 });
    expect((await unseal(SECRET, "one", t, 2, 5001)).ok).toBe(false);
    expect((await unseal(SECRET, "two", t, 2, 4000)).ok).toBe(false);
    expect((await unseal("another-secret-0123456789", "one", t, 2, 4000)).ok).toBe(false);
    expect((await unseal(SECRET, "one", t.replace("alpha", "gamma"), 2, 4000)).ok).toBe(false);
    expect((await unseal(SECRET, "one", t.replace(".5000.", ".9000."), 2, 4000)).ok).toBe(false);
    expect((await unseal(SECRET, "one", "", 2, 4000)).ok).toBe(false);
    await expect(seal(SECRET, "one", ["a.b"], 1)).rejects.toThrow();
  });

  it("binds a socket ticket to its run and keeps it apart from a Drive state", async () => {
    const run = "r".repeat(20);
    const ticket = await signTicket(SECRET, run, "f".repeat(64), "nonce1", 1000);
    expect(await verifyTicket(SECRET, ticket, run, 1000)).toEqual({ ok: true, ownerHash: "f".repeat(64), nonce: "nonce1" });
    expect((await verifyTicket(SECRET, ticket, "s".repeat(20), 1000)).ok).toBe(false);
    expect((await verifyTicket(SECRET, ticket, run, 1000 + 30_001)).ok).toBe(false);
    expect((await verifyDriveState(SECRET, ticket, 1000)).ok).toBe(false);
    const state = await signDriveState(SECRET, "nonce2", 1000);
    expect(await verifyDriveState(SECRET, state, 1000)).toEqual({ ok: true, nonce: "nonce2" });
    expect((await verifyTicket(SECRET, state, run, 1000)).ok).toBe(false);
  });
});
