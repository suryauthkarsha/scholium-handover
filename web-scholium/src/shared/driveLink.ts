// Bookkeeping for Google Drive connection attempts. Each attempt started from Settings is remembered by its
// nonce and can be redeemed exactly once, within ten minutes, by the redirect that carries the matching signed state.
// Several attempts may be open at once (a second click, a second tab), and a redirect that is loaded twice
// (a reload, a browser that re-requests the page) is shown the outcome of the first load instead of an error.
// Nothing here grants access: a repeat never exchanges a code and never changes what is stored.

export const DRIVE_LINK_TTL_MS = 10 * 60_000;
export const DRIVE_LINK_MAX_OPEN = 5;

export interface DriveAttempt {
  nonce: string;
  redirectUri: string;
  at: number;
}
export interface DriveOutcome {
  nonce: string;
  at: number;
  ok: boolean;
  message: string;
}
export interface DriveLinks {
  open: DriveAttempt[];
  last?: DriveOutcome;
}

export type Redeemed = { kind: "fresh"; redirectUri: string } | { kind: "repeat"; ok: boolean; message: string } | { kind: "expired" } | { kind: "unknown" };

const isAttempt = (v: unknown): v is DriveAttempt => {
  const a = v as DriveAttempt | null;
  return !!a && typeof a === "object" && typeof a.nonce === "string" && a.nonce.length > 0 && typeof a.redirectUri === "string" && typeof a.at === "number";
};

/** Reads what was stored, including the older single-attempt shape. Anything unreadable is dropped. */
export function readLinks(saved: unknown, legacyPending?: unknown): DriveLinks {
  const s = (saved && typeof saved === "object" ? saved : {}) as { open?: unknown; last?: unknown };
  const open = Array.isArray(s.open) ? s.open.filter(isAttempt) : [];
  if (isAttempt(legacyPending) && !open.some((a) => a.nonce === legacyPending.nonce)) open.push(legacyPending);
  const l = s.last as DriveOutcome | undefined;
  const last = l && typeof l === "object" && typeof l.nonce === "string" && typeof l.at === "number" && typeof l.ok === "boolean" && typeof l.message === "string" ? l : undefined;
  return { open: open.slice(-DRIVE_LINK_MAX_OPEN), last };
}

/** Remembers a new attempt. Old attempts lapse; at most a handful stay open. */
export function issue(links: DriveLinks, nonce: string, redirectUri: string, now: number): void {
  links.open = links.open.filter((a) => now - a.at <= DRIVE_LINK_TTL_MS && a.nonce !== nonce);
  links.open.push({ nonce, redirectUri, at: now });
  if (links.open.length > DRIVE_LINK_MAX_OPEN) links.open = links.open.slice(-DRIVE_LINK_MAX_OPEN);
}

/** Uses up the attempt with this nonce. It can be redeemed once; afterwards only its recorded outcome is shown. */
export function redeem(links: DriveLinks, nonce: string, now: number): Redeemed {
  const i = nonce ? links.open.findIndex((a) => a.nonce === nonce) : -1;
  if (i >= 0) {
    const [a] = links.open.splice(i, 1);
    return now - a.at > DRIVE_LINK_TTL_MS ? { kind: "expired" } : { kind: "fresh", redirectUri: a.redirectUri };
  }
  const l = links.last;
  if (nonce && l && l.nonce === nonce && now - l.at <= DRIVE_LINK_TTL_MS) return { kind: "repeat", ok: l.ok, message: l.message };
  return { kind: "unknown" };
}

/** Records how a redeemed attempt ended, so a second load of the same redirect can say the same thing. */
export function settle(links: DriveLinks, nonce: string, ok: boolean, message: string, now: number): void {
  links.last = { nonce, at: now, ok, message: message.slice(0, 400) };
}
