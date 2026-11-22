// Runs the workspace's own connection checks from this machine, with no keys and no model calls.
// It shows whether a tool's code path works at all; the deployed server calls out from different addresses,
// so a pass here does not prove the server is not rate-limited there.
// Usage: bun web-scholium/scripts/check-tools.ts [tool ...] [--lean=wss://…]
import { createServices } from "../src/engine/services";

const leanArg = process.argv.find((a) => a.startsWith("--lean="))?.slice(7);
const tools = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const s = createServices({
  llm: (async () => { throw new Error("no model calls in this script"); }) as never,
  toolkitSecret: "",
  settings: async () => ({ leanUrl: leanArg }),
  driveToken: async () => ({ error: "not used" }),
  driveRoot: { get: async () => undefined, set: async () => undefined },
});
for (const t of tools.length ? tools : ["search:ddg", "search:wikipedia", "search:stackexchange", "search:zbmath", "oeis", "lmfdb", "reader:jina", "lean"]) {
  const at = Date.now();
  const r = await s.preflight(t);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${t.padEnd(22)} ${r.detail.slice(0, 200)}  (${Date.now() - at} ms)`);
}
process.exit(0);
