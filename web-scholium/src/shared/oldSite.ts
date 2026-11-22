// The earlier Scholium deployments whose saved runs can be brought over. Requests go only to these addresses.
export const OLD_SITES: readonly string[] = ["https://scholium.rork.app", "https://s04v1awd9en3668b6hy1l-web-scholium.rork.live"];

/** A pass copied from the old site: its own short-lived session token. Used for the transfer and never stored. */
export const oldSitePass = (v: unknown): string => {
  const t = typeof v === "string" ? v.trim().replace(/^"|"$/g, "") : "";
  return t.length >= 20 && t.length <= 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t) ? t : "";
};
