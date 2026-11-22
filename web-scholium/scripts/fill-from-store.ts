// Compares this folder's code with the copy of the code kept in the permanent store, and fills in any file that is
// missing here (for example the three image files, which cannot travel through every channel). A file that is
// already here is never overwritten; files that differ are only listed. Nothing in the store is changed.
// Run from the project root: bun web-scholium/scripts/fill-from-store.ts
// Needs SCHOLIUM_MOVE_KEY, or EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, in the environment or in
// web-scholium/.env. No secret is ever printed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { readMoveKey } from "../worker/env";

const root = resolve(import.meta.dir, "..", "..");
const fromFile: Record<string, string> = {};
const envFile = join(root, "web-scholium", ".env");
if (existsSync(envFile))
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) fromFile[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
const read = (k: string): string => process.env[k] ?? fromFile[k] ?? "";
const move = readMoveKey(read("SCHOLIUM_MOVE_KEY"));
const url = (move?.EXPO_PUBLIC_SUPABASE_URL ?? read("EXPO_PUBLIC_SUPABASE_URL")).replace(/\/+$/, "");
const key = move?.SUPABASE_SERVICE_ROLE_KEY ?? read("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) throw new Error("The store's address and key are needed: set SCHOLIUM_MOVE_KEY (or EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).");

const res = await fetch(`${url}/rest/v1/scholium_code?select=at,sha,data&id=eq.1`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
if (!res.ok) throw new Error(`The store answered ${res.status}.`);
const row = ((await res.json()) as { at: string; sha: string; data: string }[])[0];
if (!row) throw new Error("The store holds no copy of the code.");
const bytes = Buffer.from(row.data, "base64");
if (createHash("sha256").update(bytes).digest("hex") !== row.sha) throw new Error("The code copy in the store does not match its own fingerprint.");

const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "scholium-code-"));
try {
  const pack = join(tmp, "code.tar.gz");
  const out = join(tmp, "out");
  writeFileSync(pack, bytes);
  mkdirSync(out);
  execFileSync("tar", ["-xzf", pack, "-C", out]);
  const files = execFileSync("tar", ["-tzf", pack], { maxBuffer: 64 * 1024 * 1024 }).toString().split("\n").filter((l) => l && !l.endsWith("/"));
  let same = 0;
  const filled: string[] = [];
  const differ: string[] = [];
  for (const f of files) {
    const here = join(root, f);
    if (!existsSync(here)) {
      mkdirSync(dirname(here), { recursive: true });
      cpSync(join(out, f), here);
      filled.push(f);
    } else if (readFileSync(here).equals(readFileSync(join(out, f)))) same++;
    else differ.push(f);
  }
  console.log(`Code copy in the store: ${files.length} files, saved ${row.at.slice(0, 19)}Z.`);
  console.log(`${same} files here are identical to it.`);
  if (filled.length) console.log(`Filled in ${filled.length} missing file(s):\n${filled.map((f) => `  + ${f}`).join("\n")}`);
  if (differ.length) console.log(`${differ.length} file(s) here differ from the store's copy (left as they are):\n${differ.map((f) => `  ~ ${f}`).join("\n")}`);
  if (!filled.length && !differ.length) console.log("This folder matches the store's copy exactly.");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
