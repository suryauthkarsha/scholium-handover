// Measures how large each part of every stored project is, reading the permanent store and changing nothing.
// It answers one question: what does a copy of the site have to hold in memory to open a project?
// Run from the project root: bun web-scholium/scripts/measure-store.ts
// Needs SCHOLIUM_MOVE_KEY, or EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. No secret is ever printed.
import { ALLOWED_EMAIL, ownerHashFor } from "../src/shared/gate";
import { readMoveKey, type Env } from "../worker/env";
import { restore } from "../worker/vault";

const read = (k: string): string => process.env[k] ?? "";
const move = readMoveKey(read("SCHOLIUM_MOVE_KEY"));
const url = (move?.EXPO_PUBLIC_SUPABASE_URL ?? read("EXPO_PUBLIC_SUPABASE_URL")).replace(/\/+$/, "");
const key = move?.SUPABASE_SERVICE_ROLE_KEY ?? read("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) throw new Error("The store's address and key are needed: set SCHOLIUM_MOVE_KEY.");
const env = { EXPO_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } as Env;
const num = (n: number): string => Math.round(n).toLocaleString("en-US");

const ws: string[] = [];
await restore(env, `ws:${await ownerHashFor(ALLOWED_EMAIL)}`, (units) => {
  for (const u of units) if (u.k.startsWith("run:")) ws.push(u.k.slice(4));
});

for (const id of ws) {
  const groups = new Map<string, { n: number; chars: number; max: number; maxKey: string }>();
  const fields = new Map<string, number>();
  let pages = 0;
  let maxPage = 0;
  await restore(env, `run:${id}`, (units) => {
    pages++;
    let page = 0;
    for (const u of units) {
      const size = typeof u.value === "string" ? u.value.length : u.value.byteLength;
      page += size;
      const g = u.tbl === "ent" ? `ent:${u.k.slice(0, u.k.indexOf("\t"))}` : u.tbl;
      const t = groups.get(g) ?? { n: 0, chars: 0, max: 0, maxKey: "" };
      t.n++;
      t.chars += size;
      if (size > t.max) {
        t.max = size;
        t.maxKey = u.k.replace(/\t/g, " ").slice(0, 60);
      }
      groups.set(g, t);
      // Which fields of a record carry the weight.
      if (u.tbl === "ent" && typeof u.value === "string") {
        try {
          const o = JSON.parse(u.value) as Record<string, unknown>;
          for (const [f, v] of Object.entries(o)) {
            const k = `${g}.${f}`;
            fields.set(k, (fields.get(k) ?? 0) + JSON.stringify(v ?? null).length);
          }
        } catch {
          // counted above
        }
      }
    }
    if (page > maxPage) maxPage = page;
  });
  console.log(`\nProject ${id.slice(0, 8)}…: ${pages} pages read, largest page ${num(maxPage)} characters.`);
  let ent = 0;
  let entNoCall = 0;
  for (const [g, t] of [...groups].sort((a, b) => b[1].chars - a[1].chars)) {
    console.log(`  ${g.padEnd(16)} ${num(t.n).padStart(8)} items ${num(t.chars).padStart(14)} chars  largest ${num(t.max).padStart(11)}  (${t.maxKey})`);
    if (g.startsWith("ent:")) {
      ent += t.chars;
      if (g !== "ent:call") entNoCall += t.chars;
    }
  }
  console.log(`  All records held in memory on opening: ${num(ent)} chars; without call records: ${num(entNoCall)} chars.`);
  console.log("  Heaviest record fields:");
  for (const [k, n] of [...fields].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${k.padEnd(34)} ${num(n).padStart(14)}`);
}
