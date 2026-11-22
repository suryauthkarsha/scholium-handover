// Work that happens beside the research itself: checkpoints, email alerts, Google Drive copies and tool health checks.
import { LEDGER_KINDS, type Checkpoint, type EmailLog, type EntityKind, type Phase, type RunConfig, type Snapshot } from "../shared/types";
import { ALLOWED_EMAIL } from "../shared/gate";
import type { Engine } from "./engine";
import { buildDigest, buildReport, dataFrom, goalSummary, toLatex } from "./report";
import type { EmailResult } from "./services";
import { clip, errText, oneLine, safeJson, sha256Hex } from "./util";

/** Everything needed to continue an investigation in a new run. */
export interface CheckpointExport {
  runId: string;
  checkpointId: string;
  cycle: number;
  phase: Phase;
  at: number;
  title: string;
  config: RunConfig;
  counters: Record<string, number>;
  entities: Snapshot;
}

/** Counters that keep ids unique once a ledger is carried into a branch. */
const LEDGER_COUNTERS = ["C", "V", "O", "X", "R", "S", "E", "L", "A", "U", "N", "I", "sub"];
const KEEP_CHECKPOINTS = 20;
const DRIVE_FILES_PER_PASS = 30;
const RECHECK_MS = 10 * 60000;
const SANDBOX_RETRY_MS = 15 * 60000;
const idNum = (id: string): number => Number(id.replace(/\D+/g, "")) || 0;

// ---------- checkpoints ----------
export function checkpoint(eng: Engine, reason: string): void {
  const r = eng.run;
  const now = eng.now();
  const id = eng.id("K");
  const snap = eng.snapshot();
  const d = dataFrom(snap);
  const entities: Record<string, unknown[]> = {};
  for (const k of LEDGER_KINDS) entities[k] = (snap[k] as unknown[] | undefined) ?? [];
  const counters: Record<string, number> = {};
  for (const k of LEDGER_COUNTERS) counters[k] = r.counters[k] ?? 0;
  const exp: CheckpointExport = { runId: r.id, checkpointId: id, cycle: r.cycle, phase: r.phase, at: now, title: r.config.title, config: r.config, counters, entities: entities as Snapshot };
  eng.store.putText(`ckpt:${id}`, JSON.stringify(exp));
  const cp: Checkpoint = {
    id,
    cycle: r.cycle,
    phase: r.phase,
    at: now,
    reason,
    summary: goalSummary(d).line,
    counts: {
      claims: d.claim.filter((c) => c.status === "active").length,
      evidence: d.evidence.length,
      experiments: d.experiment.length,
      sources: d.source.length,
      objections: d.objection.filter((o) => o.status === "open" || o.status === "answered" || o.status === "unresolved").length,
      obligations: d.obligation.filter((o) => o.status === "open").length,
      subagents: r.subagents.created,
    },
    spendUsd: r.spend.usd,
  };
  eng.put("checkpoint", cp);
  const all = eng.all("checkpoint").sort((a, b) => a.at - b.at || idNum(a.id) - idNum(b.id));
  while (all.length > KEEP_CHECKPOINTS) {
    const old = all.shift();
    if (!old) break;
    eng.store.putText(`ckpt:${old.id}`, "");
    eng.del("checkpoint", old.id);
  }
  eng.event("info", "checkpoint", `Checkpoint ${id} saved (${reason}).`, undefined, id);
}

/** One project as a single file the owner keeps: enough to rebuild the project on any copy of Scholium. */
export interface BackupFile {
  scholiumBackup: 1;
  owner: string;
  exportedAt: string;
  run: { id: string; title: string; status: string; cycle: number; spendUsd: number };
  checkpoint: CheckpointExport;
  /** Stored source texts by source id. */
  texts: Record<string, string>;
  /** Uploaded files by upload id, base64. */
  files: Record<string, string>;
  report: string;
  /** Everything a viewer sees, for the record. It is not read back on restore. */
  snapshot?: Snapshot;
  omitted: string[];
}

const BACKUP_TEXT_BUDGET = 12_000_000;
const BACKUP_FILE_BUDGET = 9_000_000;
const BACKUP_SNAPSHOT_BUDGET = 4_000_000;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array | null {
  try {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The ledger as it stands now, in the same shape a checkpoint has. Nothing is stored. */
export function liveExport(eng: Engine): CheckpointExport {
  const r = eng.run;
  const snap = eng.snapshot();
  const entities: Record<string, unknown[]> = {};
  for (const k of LEDGER_KINDS) entities[k] = (snap[k] as unknown[] | undefined) ?? [];
  const counters: Record<string, number> = {};
  for (const k of LEDGER_COUNTERS) counters[k] = r.counters[k] ?? 0;
  return { runId: r.id, checkpointId: "backup", cycle: r.cycle, phase: r.phase, at: eng.now(), title: r.config.title, config: r.config, counters, entities: entities as Snapshot };
}

export function buildBackup(eng: Engine): BackupFile {
  const r = eng.run;
  const omitted: string[] = [];
  const texts: Record<string, string> = {};
  let used = 0;
  let skippedTexts = 0;
  for (const s of eng.all("source")) {
    const t = eng.text(s.id);
    if (!t) continue;
    if (used + t.length > BACKUP_TEXT_BUDGET) {
      skippedTexts++;
      continue;
    }
    texts[s.id] = t;
    used += t.length;
  }
  if (skippedTexts) omitted.push(`${skippedTexts} stored source text${skippedTexts === 1 ? "" : "s"} (the sources themselves are listed in the ledger)`);
  const files: Record<string, string> = {};
  used = 0;
  for (const u of eng.all("upload")) {
    const bytes = eng.uploadBytes(u.id);
    if (!bytes) continue;
    if (used + bytes.length * 1.34 > BACKUP_FILE_BUDGET) {
      omitted.push(`the uploaded file "${oneLine(u.name, 80)}" (its extracted text is kept in the ledger)`);
      continue;
    }
    files[u.id] = toBase64(bytes);
    used += files[u.id].length;
  }
  const out: BackupFile = {
    scholiumBackup: 1,
    owner: ALLOWED_EMAIL,
    exportedAt: new Date(eng.now()).toISOString(),
    run: { id: r.id, title: r.config.title, status: r.status, cycle: r.cycle, spendUsd: r.spend.usd },
    checkpoint: liveExport(eng),
    texts,
    files,
    report: buildReport(dataFrom(eng.snapshot()), { now: eng.now(), full: true }),
    omitted,
  };
  const snap = eng.publicSnapshot();
  if (JSON.stringify(snap).length <= BACKUP_SNAPSHOT_BUDGET) out.snapshot = snap;
  else omitted.push("the full activity record (agent transcripts and events); the ledger and report are complete");
  return out;
}

/** Reads the restorable part of a backup file. Null when it is not one. */
export function readBackup(v: unknown): { checkpoint: CheckpointExport; texts: Record<string, string>; files: Record<string, string> } | null {
  const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
  const a = obj(v);
  const cp = obj(a?.checkpoint);
  const ents = obj(cp?.entities);
  if (!a || !cp || !ents || !obj(cp.config) || !obj(cp.counters) || typeof cp.cycle !== "number" || typeof cp.phase !== "string") return null;
  for (const k of Object.keys(ents)) {
    const list = ents[k];
    if (!(LEDGER_KINDS as string[]).includes(k) || !Array.isArray(list) || list.some((e) => !obj(e) || typeof obj(e)?.id !== "string")) return null;
  }
  const strings = (x: unknown): Record<string, string> => {
    const o: Record<string, string> = {};
    for (const [k, val] of Object.entries(obj(x) ?? {})) if (typeof val === "string" && val && /^[A-Za-z0-9_-]{1,64}$/.test(k)) o[k] = val;
    return o;
  };
  return { checkpoint: { ...(cp as unknown as CheckpointExport), checkpointId: "backup", at: typeof cp.at === "number" ? cp.at : 0, title: typeof cp.title === "string" ? cp.title : "", runId: typeof cp.runId === "string" ? cp.runId : "" }, texts: strings(a.texts), files: strings(a.files) };
}

export function exportCheckpoint(eng: Engine, id: string): CheckpointExport | null {
  if (!eng.m.checkpoint.has(id)) return null;
  const raw = eng.store.getText(`ckpt:${id}`);
  if (!raw) return null;
  const data = safeJson<CheckpointExport>(raw);
  return data && typeof data === "object" && data.entities ? data : null;
}

/** Loads a checkpoint's ledger into a fresh run. Source texts and uploaded files are copied separately by the host. */
export function importCheckpoint(eng: Engine, data: CheckpointExport): void {
  const r = eng.run;
  const ents = (data.entities ?? {}) as Record<string, unknown>;
  const seen: Record<string, number> = {};
  const note = (ref: unknown): void => {
    if (typeof ref !== "string") return;
    const m = /^([A-Z])(\d+)$/.exec(ref);
    if (m) seen[m[1]] = Math.max(seen[m[1]] ?? 0, Number(m[2]));
    const s = /^sub-(\d+)$/.exec(ref);
    if (s) seen.sub = Math.max(seen.sub ?? 0, Number(s[1]));
  };
  for (const k of LEDGER_KINDS) {
    const list = Array.isArray(ents[k]) ? (ents[k] as Record<string, unknown>[]) : [];
    for (const e of list) {
      if (!e || typeof e !== "object" || typeof e.id !== "string") continue;
      (eng.put as (kind: EntityKind, e: unknown) => void).call(eng, k, e);
      note(e.id);
      note(e.byAgent);
      note(e.authorId);
      note(e.raisedBy);
    }
  }
  const from = data.counters ?? {};
  for (const k of LEDGER_COUNTERS) {
    const n = Math.max(r.counters[k] ?? 0, typeof from[k] === "number" ? from[k] : 0, seen[k] ?? 0);
    if (n) r.counters[k] = n;
  }
  eng.touch();
  eng.reassess();
  const name = (id: string): string => eng.m.agent.get(id)?.name ?? id;
  for (const c of eng.all("claim")) eng.indexClaim(c);
  for (const n of eng.all("note")) eng.index(n.id, "note", `${n.kind} by ${name(n.byAgent)}`, n.text);
  for (const x of eng.all("experiment")) eng.index(x.id, "experiment", x.purpose, `${x.code}\n${x.stdout}`);
  for (const a of eng.all("artifact")) eng.index(a.id, "artifact", a.title, a.content.slice(0, 20000));
  for (const o of eng.all("objection")) eng.index(o.id, "objection", `Objection to ${o.claimId}`, o.text);
  for (const i of eng.all("instruction")) eng.index(i.id, "instruction", "Instruction from the user", i.text);
  for (const s of eng.all("source")) eng.index(s.id, "source", s.title, s.snippet || s.title);
}

// ---------- email ----------
function mask(to: string): string {
  const at = to.indexOf("@");
  if (at < 1) return to ? "•••" : "";
  return `${to.slice(0, Math.min(2, at))}•••${to.slice(at)}`;
}

/** Sends an alert. Never blocks the run: delivery happens in the background and its real outcome is logged. */
export function notify(eng: Engine, kind: EmailLog["kind"]): void {
  const r = eng.run;
  const al = r.config.alerts;
  if (kind !== "test") {
    if (!al.enabled) return;
    if (kind === "goal" && !al.onGoal) return;
    if (kind === "attention" && !al.onAttention) return;
  }
  const now = eng.now();
  const msg = buildDigest(dataFrom(eng.snapshot()), kind, now);
  if (kind === "digest") {
    r.lastDigestAt = now;
    r.nextDigestAt = now + al.intervalMin * 60000;
    eng.touch();
  }
  eng.track(`email:${kind}:${now}`, async () => {
    let res: EmailResult;
    try {
      res = await eng.services.email(msg);
    } catch (e) {
      res = { status: "failed", detail: errText(e), to: "" };
    }
    if (res.status === "skipped") {
      const key = `skipmail_${kind}`;
      if (eng.run.counters[key]) return;
      eng.run.counters[key] = 1;
      eng.touch();
    }
    const log: EmailLog = { id: eng.id("M"), kind, to: mask(res.to), subject: msg.subject, status: res.status, detail: res.detail ? clip(res.detail, 400) : undefined, at: eng.now() };
    eng.put("email", log);
    if (res.status === "sent") eng.event("info", "email", `Email sent to ${log.to}: "${msg.subject}".`, undefined, log.id);
    else eng.event("warn", "email", `Email "${msg.subject}" was ${res.status === "skipped" ? "not sent" : "not delivered"}: ${oneLine(res.detail, 300)}`, undefined, log.id);
  });
}

// ---------- Google Drive ----------
interface OutFile {
  name: string;
  mime: string;
  content: string;
}

const safeName = (s: string): string =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

function driveFiles(eng: Engine): OutFile[] {
  const r = eng.run;
  const title = r.config.title || "Scholium run";
  const md = buildReport(dataFrom(eng.snapshot()), { now: eng.now(), full: true });
  const out: OutFile[] = [
    { name: "report.md", mime: "text/markdown", content: md },
    { name: "report.tex", mime: "application/x-tex", content: toLatex(md, title) },
    { name: "ledger.json", mime: "application/json", content: eng.export("json").content },
  ];
  for (const a of eng.all("artifact")) {
    if (a.kind === "report") continue;
    out.push({ name: `artifact-${a.id}-${safeName(a.filename || a.title) || "file"}`, mime: "text/plain", content: a.content });
  }
  for (const x of eng.all("experiment")) {
    if (!x.code.trim()) continue;
    const ext = x.lang === "python" ? "py" : x.lang === "sage" ? "sage" : "sh";
    out.push({ name: `experiment-${x.id}.${ext}`, mime: "text/plain", content: x.code });
  }
  return out;
}

function driveDue(eng: Engine, now: number): boolean {
  const r = eng.run;
  if (!r.config.drive || r.status === "draft" || eng.jobs.has("drive")) return false;
  const last = r.driveLastSyncAt;
  if (last === undefined) return true;
  if (r.counters.driveMore) return now - last >= 3000;
  const newest = Math.max(0, ...eng.all("checkpoint").map((c) => c.at));
  if (newest > last) return true;
  return r.status === "running" && now - last >= eng.opts.driveSyncMs;
}

async function driveSync(eng: Engine): Promise<void> {
  const r = eng.run;
  const drive = eng.services.drive;
  let saved = 0;
  try {
    const st = await drive.status();
    if (!st.connected) throw new Error(st.detail || "Google Drive is not connected.");
    if (!r.driveFolderId) {
      const f = await drive.ensureRunFolder(r.config.title || oneLine(r.config.goal, 60) || "Untitled run");
      r.driveFolderId = f.id;
      r.driveFolderUrl = f.url;
      eng.touch();
      eng.event("info", "drive", "A folder for this run was created in Google Drive.");
    }
    const folder = r.driveFolderId;
    let more = false;
    // The ledger export changes with every model call, so it is compared last and written at most once per pass.
    for (const f of driveFiles(eng)) {
      const hash = await sha256Hex(f.content);
      const cur = eng.m.drivefile.get(f.name);
      if (cur && cur.hash === hash && cur.fileId && !cur.error) continue;
      if (saved >= DRIVE_FILES_PER_PASS) {
        more = true;
        break;
      }
      let fileId: string;
      try {
        fileId = await drive.putFile(folder, f.name, f.mime, f.content, cur?.fileId);
      } catch (e) {
        if (!cur?.fileId) throw e;
        // The file may have been deleted in Drive: write it again as a new file.
        fileId = await drive.putFile(folder, f.name, f.mime, f.content);
      }
      eng.put("drivefile", { id: f.name, name: f.name, fileId, hash, syncedAt: eng.now() });
      saved++;
    }
    r.counters.driveMore = more ? 1 : 0;
    if (r.driveError) eng.event("info", "drive", "Google Drive is reachable again.");
    r.driveError = undefined;
    if (saved) eng.event("info", "drive", `${saved} file${saved === 1 ? "" : "s"} saved to Google Drive.`);
  } catch (e) {
    const msg = clip(errText(e), 400);
    if (/HTTP 404/.test(msg)) {
      // The run's folder is gone: start over with a new one on the next pass.
      r.driveFolderId = undefined;
      r.driveFolderUrl = undefined;
      for (const f of eng.all("drivefile")) eng.del("drivefile", f.id);
    }
    r.counters.driveMore = 0;
    if (r.driveError !== msg) eng.event("warn", "drive", `Saving to Google Drive failed: ${oneLine(msg, 300)}`);
    r.driveError = msg;
  } finally {
    r.driveLastSyncAt = eng.now();
    eng.touch();
  }
}

// ---------- the background pass ----------
export function runBackground(eng: Engine): void {
  const r = eng.run;
  if (r.status === "draft") return;
  const now = eng.now();
  if (r.status === "running" && r.config.alerts.enabled && r.nextDigestAt !== undefined && now >= r.nextDigestAt) notify(eng, "digest");
  if (driveDue(eng, now)) eng.track("drive", () => driveSync(eng));
  if (r.status !== "running") return;
  const tools = r.config.tools as unknown as Record<string, unknown>;
  const stale = ["web", "literature", "oeis", "sage", "lean"].filter((n) => {
    const st = r.toolStatus[n];
    return tools[n] === true && !!st && !st.ok && now - st.checkedAt >= RECHECK_MS;
  });
  if (stale.length) eng.track("preflight", () => eng.preflight((n) => stale.includes(n)));
  const sb = r.toolStatus.sandbox;
  if (sb && !sb.ok && now - sb.checkedAt >= SANDBOX_RETRY_MS) {
    // Half-open: one more failure switches the sandbox off again, one success restores it.
    delete r.toolStatus.sandbox;
    r.counters.infra_sandbox = 2;
    eng.touch();
    eng.event("info", "tool", "The code sandbox is switched back on for a trial after 15 minutes off.");
  }
}
