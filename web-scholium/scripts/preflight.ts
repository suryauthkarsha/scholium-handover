// One command that says whether this copy of the site is ready for the owner's "Continue here" press.
// It only reads: nothing in the store, on any site or in this project's settings is changed, and it never takes
// the turn. It prints names and yes/no only, never a secret or anything opened from one.
// Run from the project root, after publishing:
//   rork env run -e production -- bun web-scholium/scripts/preflight.ts https://<published address>
// The address is optional; without it the two checks of the published site are skipped.
// Ends with "Ready" (exit 0) or a numbered list of what to fix (exit 1).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ALLOWED_EMAIL, ownerHashFor } from "../src/shared/gate";
import { readMoveKey, type Env } from "../worker/env";
import { codeInfo, hasRows } from "../worker/vault";

const root = resolve(import.meta.dir, "..", "..");
const fromFile: Record<string, string> = {};
const envFile = join(root, "web-scholium", ".env");
if (existsSync(envFile))
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) fromFile[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
const read = (k: string): string => process.env[k] ?? fromFile[k] ?? "";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const fixes: string[] = [];
const site = (process.argv[2] ?? "").trim().replace(/\/+$/, "");
const siteHost = /^https:\/\//.test(site) ? new URL(site).host : "";
let turnHere = false;
const ok = (text: string): void => console.log(`  ok    ${text}`);
const bad = (text: string, fix: string): void => {
  console.log(`  FIX   ${text}`);
  fixes.push(fix);
};
const note = (text: string): void => console.log(`  note  ${text}`);

// ---- 1. The settings the published site receives ----
// Rork's own keys are not all handed to a script by `rork env run`, so the names are read from the list instead.
console.log("Settings of the published site");
const listed = new Map<string, Rec>();
let listWorked = false;
try {
  const out = Bun.spawnSync(["rork", "env", "ls", "-e", "production", "--json"], { stdout: "pipe", stderr: "pipe" });
  const vars = rec(JSON.parse(out.stdout.toString())).variables;
  if (out.exitCode === 0 && Array.isArray(vars)) {
    for (const v of vars) if (typeof rec(v).name === "string") listed.set(String(rec(v).name), rec(v));
    listWorked = true;
  }
} catch {
  // Falls through to what this process can see.
}
if (!listWorked) note("`rork env ls -e production --json` did not answer, so only the settings this command can see are checked.");
const has = (name: string): boolean => (listWorked ? listed.has(name) : !!read(name));

const NEEDED: [name: string, what: string, fix: string][] = [
  ["SCHOLIUM_MOVE_KEY", "the move key", "Ask the owner for SCHOLIUM_MOVE_KEY with the secrets widget (server-only, for the published site as well as the preview)."],
  ["EXPO_PUBLIC_PROJECT_ID", "this project's id, which sign-in is checked against", "Run: rork env set EXPO_PUBLIC_PROJECT_ID=$RORK_PROJECT --client -e all   (then publish again)."],
  ["EXPO_PUBLIC_RORK_APP_KEY", "sign-in", "Run: rork auth enable --json   (then publish again)."],
  ["RORK_AUTH_SECRET_KEY", "sign-in", "Run: rork auth enable --json   (then publish again)."],
  ["RORK_AUTH_URL", "sign-in", "Run: rork auth enable --json   (then publish again)."],
  ["EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY", "the models, on this account's own Rork AI Cloud", "Run: rork ai keys get --json   (then publish again)."],
];
for (const [name, what, fix] of NEEDED) {
  if (has(name)) ok(`${name} is set (${what})`);
  else bad(`${name} is not set (${what})`, fix);
}
if (has("MODEL_ACCOUNT_KEY")) bad("MODEL_ACCOUNT_KEY is set: model calls would go to some other account", "Remove MODEL_ACCOUNT_KEY from both environments: rork env unset MODEL_ACCOUNT_KEY -e production   and   rork env unset MODEL_ACCOUNT_KEY   (then publish again).");
else ok("MODEL_ACCOUNT_KEY is not set (model calls use this account)");

// ---- 2. The project id sign-in is checked against ----
// A wrong or missing id does not show until the owner signs in: the site then answers 401 "claims" to every request.
console.log("\nSign-in");
const listedId = listed.get("EXPO_PUBLIC_PROJECT_ID")?.value;
const projectId = (typeof listedId === "string" ? listedId : read("EXPO_PUBLIC_PROJECT_ID")).trim();
const here = (process.env.RORK_PROJECT ?? "").trim();
if (!projectId) note("EXPO_PUBLIC_PROJECT_ID could not be read here; see the line above.");
else if (!/^[a-z0-9]{12,40}$/.test(projectId)) bad("EXPO_PUBLIC_PROJECT_ID does not look like a Rork project id", "Set it again: rork env set EXPO_PUBLIC_PROJECT_ID=$RORK_PROJECT --client -e all   (then publish again).");
else if (here && projectId !== here) bad("EXPO_PUBLIC_PROJECT_ID is another project's id, so sign-in would be refused (401 \"claims\")", "Set it to this project: rork env set EXPO_PUBLIC_PROJECT_ID=$RORK_PROJECT --client -e all   (then publish again).");
else if (here) ok("EXPO_PUBLIC_PROJECT_ID is this project's id");
else note("RORK_PROJECT is not set in this shell, so the id could not be compared with this project's. It must be this project's id.");

// ---- 3. The move key and the store ----
console.log("\nThe move key and the permanent store");
const move = readMoveKey(read("SCHOLIUM_MOVE_KEY"));
if (!read("SCHOLIUM_MOVE_KEY")) {
  bad("SCHOLIUM_MOVE_KEY is not visible to this command", "Run this through `rork env run -e production -- bun web-scholium/scripts/preflight.ts`, after the owner has set SCHOLIUM_MOVE_KEY.");
} else if (!move) {
  bad("SCHOLIUM_MOVE_KEY is set but cannot be opened (cut short, or not a move key)", "Ask the owner to copy the move key again (old site: Settings, \"Move to another Rork account\", \"Copy the move key\") and replace the secret.");
} else {
  ok("The move key opens");
  const optional = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "RESEND_API_KEY", "RESEND_FROM", "ALERT_EMAIL_TO"] as const;
  const absent = optional.filter((f) => !move[f]);
  if (absent.length) note(`The move key does not carry: ${absent.join(", ")}. The matching feature (Google Drive, email alerts) stays off until the owner sets it up again.`);
  else ok("It carries the Google Drive and email settings");

  const url = (move.EXPO_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = move.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const env = { EXPO_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } as Env;
  try {
    const res = await fetch(`${url}/rest/v1/scholium_lease?select=site,label,epoch,at`, { headers: { apikey: key, authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`the store answered ${res.status}`);
    const lease = (await res.json()) as Rec[];
    ok(`The store answers (${new URL(url).host})`);
    if (await hasRows(env, `ws:${await ownerHashFor(ALLOWED_EMAIL)}`)) ok(`It holds the workspace of ${ALLOWED_EMAIL}`);
    else bad(`The store holds no workspace for ${ALLOWED_EMAIL}`, "This move key points at a store without the owner's work. Ask the owner for the move key of the site that holds it. Do not change ALLOWED_EMAIL.");
    const l = lease[0];
    turnHere = !!l && !!siteHost && String(l.label) === siteHost;
    if (l && turnHere) note(`The turn is already with this site (turn ${String(l.epoch)}, since ${String(l.at).slice(0, 19)}Z): the owner has pressed "Continue here" and the work carries on here.`);
    else if (l) note(`The turn is with: ${String(l.label || "unnamed")} (turn ${String(l.epoch)}, since ${String(l.at).slice(0, 19)}Z). It moves only when the owner presses "Continue here".`);
    else note("No copy holds the turn yet.");
    const code = await codeInfo(env);
    if (code) note(`The store's own copy of the code: ${code.files} files, saved ${code.at.slice(0, 19)}Z. The repository may be newer; the repository wins.`);
  } catch (e) {
    bad(`The store did not answer (${e instanceof Error ? e.message : "no reply"})`, "The database may be paused (a free Supabase project sleeps after a week without use). The owner restores it in the Supabase dashboard; nothing is lost.");
  }
}

// ---- 4. The published site ----
console.log("\nThe published site");
if (!site) note("No address given, so the published site was not checked. Add it: preflight.ts https://<published address>");
else if (!/^https:\/\//.test(site)) bad("The address must start with https://", "Give the published address, for example https://web-scholium-publish.rork.app");
else {
  try {
    const health = await fetch(`${site}/api/health`, { signal: AbortSignal.timeout(20_000) });
    const body = rec(await health.json().catch(() => ({})));
    if (health.ok && body.ok === true) ok(`${new URL(site).host} answers`);
    else bad(`${site}/api/health answered ${health.status}`, "Publish again: rork checks --app web-scholium --json   and   rork web publish web-scholium --json");
    const closed = await fetch(`${site}/api/workspace`, { signal: AbortSignal.timeout(20_000) });
    if (closed.status === 401) ok("It lets nobody in without sign-in");
    else bad(`${site}/api/workspace answered ${closed.status} while signed out (401 expected)`, "The sign-in code was changed or the wrong app was published. Publish web-scholium unchanged from the repository.");
    if (/\.rork\.live$/.test(new URL(site).host)) note("This is the preview address. The owner should press \"Continue here\" on the published address, which is a separate copy.");
  } catch (e) {
    bad(`${site} did not answer (${e instanceof Error ? e.message : "no reply"})`, "Publish the site: rork web publish web-scholium --json");
  }
}

// ---- The verdict ----
if (fixes.length) {
  console.log(`\nNOT READY. Fix, in this order:`);
  [...new Set(fixes)].forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  console.log("Then publish again and run this again.");
  process.exit(1);
}
if (turnHere) console.log("\nReady, and already carrying on here: nothing is left to do for the move.");
else console.log(`\nReady. What is left is the owner's: open the published address, sign in as ${ALLOWED_EMAIL}, press "Continue here".`);
console.log("This check cannot see behind sign-in. If the owner's sign-in is refused, see \"When something is not as described\" in README.md.");
