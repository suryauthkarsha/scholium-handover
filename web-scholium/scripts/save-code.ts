// Packs the site's code (this app, the store's database setup and the handover guide) into one .tar.gz and keeps it
// in the permanent store, where Settings offers it as a download. Run from the project root: bun web-scholium/scripts/save-code.ts
// Needs EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment. Secrets (.env) are never packed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
let url = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
if (!url && existsSync(join(root, "web-scholium", ".env"))) url = (/^EXPO_PUBLIC_SUPABASE_URL=(.*)$/m.exec(readFileSync(join(root, "web-scholium", ".env"), "utf8"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) throw new Error("EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed.");

const out = join(process.env.TMPDIR || tmpdir(), `scholium-code-${Date.now()}.tar.gz`);
const skip = ["node_modules", "dist", ".env", ".env.*", ".wrangler", ".vercel", "*.log", ".DS_Store"];
execFileSync("tar", ["-czf", out, ...skip.map((s) => `--exclude=${s}`), "-C", root, "web-scholium", "supabase/migrations", ...["README.md", "AGENTS.md"].filter((f) => existsSync(join(root, f)))], { stdio: "inherit" });
const files = execFileSync("tar", ["-tzf", out], { maxBuffer: 64 * 1024 * 1024 }).toString().split("\n").filter((l) => l && !l.endsWith("/")).length;
const bytes = readFileSync(out);
const sha = createHash("sha256").update(bytes).digest("hex");

const res = await fetch(`${url}/rest/v1/scholium_code?on_conflict=id`, {
  method: "POST",
  headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
  body: JSON.stringify({ id: 1, at: new Date().toISOString(), bytes: bytes.length, files, sha, data: bytes.toString("base64") }),
});
if (!res.ok) throw new Error(`The store answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
console.log(`Saved ${files} files, ${(bytes.length / 1024).toFixed(0)} KB, sha256 ${sha.slice(0, 16)}…`);
