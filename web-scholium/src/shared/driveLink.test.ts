import { describe, expect, it } from "vitest";

import { DRIVE_LINK_MAX_OPEN, DRIVE_LINK_TTL_MS, issue, readLinks, redeem, settle, type DriveLinks } from "./driveLink";

const URI = "https://scholium.rork.app/api/drive/callback";
const fresh = (): DriveLinks => readLinks(undefined);

describe("Google Drive connection attempts", () => {
  it("redeems an attempt exactly once", () => {
    const l = fresh();
    issue(l, "n1", URI, 1000);
    expect(redeem(l, "n1", 2000)).toEqual({ kind: "fresh", redirectUri: URI });
    // Not settled yet (the first load is still talking to Google): a second load must not get a second exchange.
    expect(redeem(l, "n1", 2001)).toEqual({ kind: "unknown" });
  });

  it("refuses a nonce that was never issued, an empty one, and one that lapsed", () => {
    const l = fresh();
    issue(l, "n1", URI, 1000);
    expect(redeem(l, "other", 2000)).toEqual({ kind: "unknown" });
    expect(redeem(l, "", 2000)).toEqual({ kind: "unknown" });
    expect(redeem(l, "n1", 1000 + DRIVE_LINK_TTL_MS + 1)).toEqual({ kind: "expired" });
    expect(redeem(l, "n1", 1000 + DRIVE_LINK_TTL_MS + 2)).toEqual({ kind: "unknown" });
  });

  it("keeps an earlier attempt usable when Connect is pressed again", () => {
    const l = fresh();
    issue(l, "first", URI, 1000);
    issue(l, "second", URI, 2000);
    expect(redeem(l, "first", 3000).kind).toBe("fresh");
    expect(redeem(l, "second", 3000).kind).toBe("fresh");
  });

  it("keeps only a handful of attempts open", () => {
    const l = fresh();
    for (let i = 0; i < DRIVE_LINK_MAX_OPEN + 3; i++) issue(l, `n${i}`, URI, 1000 + i);
    expect(l.open).toHaveLength(DRIVE_LINK_MAX_OPEN);
    expect(redeem(l, "n0", 5000)).toEqual({ kind: "unknown" });
    expect(redeem(l, `n${DRIVE_LINK_MAX_OPEN + 2}`, 5000).kind).toBe("fresh");
  });

  it("shows a reloaded redirect the first outcome, without a second redemption", () => {
    const l = fresh();
    issue(l, "n1", URI, 1000);
    expect(redeem(l, "n1", 2000).kind).toBe("fresh");
    settle(l, "n1", true, "Connected.", 2500);
    expect(redeem(l, "n1", 3000)).toEqual({ kind: "repeat", ok: true, message: "Connected." });
    expect(redeem(l, "n2", 3000)).toEqual({ kind: "unknown" });
    expect(redeem(l, "n1", 2500 + DRIVE_LINK_TTL_MS + 1)).toEqual({ kind: "unknown" });
    const f = fresh();
    issue(f, "n3", URI, 1000);
    redeem(f, "n3", 1500);
    settle(f, "n3", false, "Google refused.", 1600);
    expect(redeem(f, "n3", 1700)).toEqual({ kind: "repeat", ok: false, message: "Google refused." });
  });

  it("reads the older stored shape and drops anything unreadable", () => {
    const l = readLinks(undefined, { nonce: "old", redirectUri: URI, at: 1000 });
    expect(redeem(l, "old", 2000).kind).toBe("fresh");
    const j = readLinks({ open: [{ nonce: 5 }, null, { nonce: "ok", redirectUri: URI, at: 1 }], last: { nonce: "x" } });
    expect(j.open.map((a) => a.nonce)).toEqual(["ok"]);
    expect(j.last).toBeUndefined();
  });
});
