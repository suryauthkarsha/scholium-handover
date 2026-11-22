// One research run: its database, its engine, its live viewers. The run keeps working here whether or not
// anyone is signed in or watching. Only the router and sibling objects can reach it (see fromInside).
import { DurableObject } from "cloudflare:workers";
import { buildBackup, fromBase64, readBackup, type CheckpointExport } from "../src/engine/background";
import { Engine, type ActionResult } from "../src/engine/engine";
import { createGateway } from "../src/engine/providers";
import { modelAccount } from "../src/shared/modelAccount";
import { createServices, type Services } from "../src/engine/services";
import type { ActiveMethod } from "../src/engine/strategy";
import { errText, fmtUsd } from "../src/engine/util";
import { WS_TICKET_TTL_MS } from "../src/shared/gate";
import { OLD_SITES, oldSitePass } from "../src/shared/oldSite";
import { ENTITY_KINDS, type EntityKind, type RunSummary, type ServerMsg } from "../src/shared/types";
import { callObject, type Env, fail, fromInside, json, notFound, readBody, rec, withMoveKey } from "./env";
import { SqlStore } from "./sql-store";
import { type Cursor, Dirty, dropObject, hasRows, type Lease, Mirror, newTally, restore, sameValue, type Tally, vaultOn } from "./vault";
import { STANDBY } from "./workspace-do";

const BIG = 350_000;
type RemoteRun = { base: string; token: string; runId: string };
const BATCH = 300_000;
const WATCHDOG_MS = 45_000;
const REPORT_MS = 10_000;
const ID = "([A-Za-z0-9_-]{1,64})";
/** How much of a run is read back from the store in one step (each page is up to 3 MB). */
const RESTORE_PAGES = 8;
/** Where a read-back from the store has got to. Kept only on this copy. */
interface Restoring {
  tbl: string;
  k: string;
  epoch: number;
  n: number;
  id: string;
  owner: string;
  /** True once what was here before has been cleared and the first piece from the store is in. */
  w: boolean;
}

const attachment = (name: string): string => `attachment; filename="${name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "file"}"`;

export class ResearchRun extends DurableObject<Env> {
  private store: SqlStore;
  private engine: Engine | null = null;
  private owner = "";
  private runId = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = 0;
  private alarmAt = 0;
  private ticking = false;
  private again = false;
  private reportTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSig = "";
  private reported = { written: 0, read: 0, calls: 0 };
  private calls = 0;
  private destroyed = false;
  // The permanent store: the lease this run writes under, and whether this copy of the site is on standby.
  private dirty: Dirty | null = null;
  private mirror: Mirror | null = null;
  private held: Lease | null = null;
  private standby = false;
  private gateAt = 0;
  private gating: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** How soon the next step of a read-back from the store is taken: at once after a good step, later after a failed one. */
  private restoreIn = 60_000;

  constructor(ctx: DurableObjectState, raw: Env) {
    const env = withMoveKey(raw);
    super(ctx, env);
    this.store = new SqlStore(ctx.storage);
    if (vaultOn(env)) {
      this.dirty = new Dirty((query, ...bindings) => this.store.sql(query, ...bindings));
      this.store.dirty = this.dirty;
      this.held = this.store.kvGet<Lease>("vault:lease") ?? null;
      this.standby = this.store.kvGet<boolean>("vault:standby") === true;
    }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------- Engine ----------
  private workspace(method: string, path: string, body?: unknown): Promise<Response> {
    return callObject(this.env.WORKSPACE, `ws:${this.owner}`, this.env, this.owner, method, path, body);
  }

  private async ask<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    try {
      const r = await this.workspace(method, path, body);
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  }

  private build(): Engine {
    const env = this.env;
    // Every free-tier side effect asks the workspace first, which counts it against a hard daily or monthly cap.
    const take = async (kind: "exa" | "email" | "drive"): Promise<boolean> => (await this.ask<{ ok?: boolean }>("POST", "/internal/take", { kind }))?.ok === true;
    const base = createServices({
      llm: createGateway({ secret: modelAccount(env).secret }),
      toolkitSecret: modelAccount(env).secret,
      settings: async () => (await this.ask<{ exaKey?: string; leanUrl?: string }>("GET", "/internal/secrets")) ?? {},
      driveToken: async () => (await this.ask<{ token?: string; error?: string }>("POST", "/internal/drive-token")) ?? { error: "The workspace could not be reached." },
      driveRoot: {
        get: async () => (await this.ask<{ id?: string }>("GET", "/internal/drive-root"))?.id,
        set: async (id) => {
          await this.ask("PUT", "/internal/drive-root", { id });
        },
      },
      resendKey: env.RESEND_API_KEY,
      stackExchangeKey: env.STACKEXCHANGE_KEY,
      emailTo: env.ALERT_EMAIL_TO,
      emailFrom: env.RESEND_FROM,
      take,
    });
    const services: Services = {
      ...base,
      method: () => this.ask<ActiveMethod>("GET", "/internal/strategy/active"),
      email: async (msg) => ((await take("email")) ? base.email(msg) : { status: "skipped", detail: "Today's email limit was reached, so nothing was sent.", to: env.ALERT_EMAIL_TO ?? "" }),
      drive: {
        ...base.drive,
        putFile: async (folderId, name, mime, content, existing) => {
          if (!(await take("drive"))) throw new Error("Today's Google Drive upload limit was reached.");
          return base.drive.putFile(folderId, name, mime, content, existing);
        },
      },
    };
    return new Engine(this.store, services, { broadcast: (m) => this.broadcast(m), wake: (d) => this.wake(d), summary: (s) => this.queueReport(s) });
  }

  // ---------- The permanent store ----------
  private setStandby(on: boolean): void {
    if (this.standby === on) return;
    this.standby = on;
    this.store.kvSet("vault:standby", on);
    if (on && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!on && this.engine?.run.status === "running") void this.wake(0);
  }

  /**
   * Lines this run up with the workspace's present standing: working (and under which lease) or standby.
   * A run that has not yet worked under the present lease first either takes its exact state from the store
   * or copies its own state there, whichever the owner chose when the work moved to this copy of the site.
   */
  private gate(force = false): Promise<void> {
    if (!this.dirty || !this.owner || !this.runId) return Promise.resolve();
    if (!force && Date.now() - this.gateAt < 20_000) return this.gating ?? Promise.resolve();
    this.restoreIn = 60_000;
    this.gating ??= (async () => {
      const s = await this.ask<{ mode: string; site?: string; epoch?: number; source?: string }>("GET", "/internal/vault/lease");
      if (!s) return;
      if (s.mode === "standby") this.setStandby(true);
      else if (s.mode === "active" && typeof s.site === "string" && typeof s.epoch === "number") {
        if (!this.held || this.held.site !== s.site || this.held.epoch !== s.epoch) {
          const obj = `run:${this.runId}`;
          // A read-back that was begun is always finished: until then this copy holds only part of the run.
          if (this.store.kvGet("vault:restoring") || (s.source === "vault" && (await hasRows(this.env, obj)))) {
            if (!(await this.pullStore(obj, s.epoch))) {
              this.restoreIn = 1500;
              return;
            }
          } else this.store.markAll();
          this.held = { site: s.site, label: "", epoch: s.epoch };
          this.store.kvSet("vault:lease", this.held);
        }
        this.setStandby(false);
        await this.resumeAfterMove();
      }
      this.gateAt = Date.now();
    })()
      .catch((err) => console.error("store check failed:", errText(err).slice(0, 300)))
      .finally(async () => {
        this.gating = null;
        // Not all read back yet (a long run comes back in steps, or the store was out of reach): carry on shortly.
        if (this.store.kvGet("vault:restoring") && !this.destroyed) {
          this.gateAt = 0;
          this.alarmAt = Date.now() + this.restoreIn;
          try {
            await this.ctx.storage.setAlarm(this.alarmAt);
          } catch {
            this.alarmAt = 0;
          }
        }
      });
    return this.gating;
  }

  /**
   * The owner moved the work to this copy and asked for paused projects to carry on: once the run is all here,
   * it is resumed exactly as the Resume button would, under the same spending limits. Asked for once, done once.
   */
  private async resumeAfterMove(): Promise<void> {
    const e = this.engine;
    if (!e || this.standby || !this.store.kvGet("vault:resume") || this.store.kvGet("vault:restoring")) return;
    this.store.kvDel("vault:resume");
    if (e.run.status !== "paused") return;
    try {
      const denied = await this.grant(e);
      const r = denied ? { ok: false as const, error: denied } : await e.action("resume");
      if (r.ok) e.event("info", "run", "The work was moved to this copy of the site and carries on here.");
      else e.event("warn", "run", `The project was moved to this copy of the site but could not be resumed: ${r.error}`);
    } catch (err) {
      e.event("warn", "run", `The project was moved to this copy of the site but could not be resumed: ${errText(err).slice(0, 200)}`);
    }
    e.flush();
    this.queueReport();
    void this.tick();
  }

  /**
   * Replaces this run's database with the exact state held in the store, then carries on from it.
   * A long run is read back in steps: each step keeps what it read together with the place it reached, so
   * a step that is cut short loses nothing and the next one carries on from there. Returns true once it is all here.
   */
  private async pullStore(obj: string, epoch: number): Promise<boolean> {
    const old = this.engine;
    if (old) await Promise.race([old.idle(), new Promise((r) => setTimeout(r, 4000))]);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.engine = null;
    this.lastSig = "";
    const saved = this.store.kvGet<Restoring | true>("vault:restoring");
    // Carry on only under the same lease: under a newer one the store may have changed, so start again.
    const st = saved && typeof saved === "object" && saved.epoch === epoch ? saved : null;
    let first = !st?.w;
    let n = st?.w ? st.n : 0;
    // Until the last piece is in, the run is not opened: half a run is never shown or worked on.
    if (!st) this.store.kvSet("vault:restoring", { tbl: "", k: "", epoch, n: 0, id: this.runId, owner: this.owner, w: false } satisfies Restoring);
    const r = await restore(
      this.env,
      obj,
      (units, cursor) =>
        this.store.transaction(() => {
          if (first) this.store.wipe();
          first = false;
          for (const u of units) this.store.rawPut(u.tbl, u.k, u.value);
          n += units.length;
          this.store.kvSet("vault:restoring", { ...cursor, epoch, n, id: this.runId, owner: this.owner, w: true } satisfies Restoring);
        }),
      { from: st?.w ? { tbl: st.tbl, k: st.k } : undefined, maxPages: RESTORE_PAGES },
    );
    if (!r.done) return false;
    this.store.rawPut("kv", "meta", JSON.stringify({ id: this.runId, owner: this.owner }));
    this.store.setEventMark(this.store.trimEvents());
    this.store.kvDel("vault:restoring");
    const e = this.build();
    if (e.load()) {
      e.reindex();
      this.engine = e;
      // A run that was working when it was last saved carries on from exactly there.
      if (e.run.status === "running") void this.wake(0);
    }
    return true;
  }

  /**
   * Compares what the store holds for this run with what is here, item by item and character for character.
   * One call covers a few megabytes and says where the next call carries on. Nothing is changed by it.
   */
  private async checkStore(at: string): Promise<Response> {
    const d = this.dirty;
    if (!d) return fail(409, "not_configured", "The permanent store is not set up on this copy.");
    let from: Cursor | undefined;
    if (at) {
      try {
        const c = rec(JSON.parse(at));
        if (typeof c.tbl === "string" && typeof c.k === "string") from = { tbl: c.tbl, k: c.k };
      } catch {
        return fail(400, "bad_request", "The check could not be carried on from there.");
      }
    }
    const groups: Record<string, Tally> = {};
    try {
      const r = await restore(
        this.env,
        `run:${this.runId}`,
        (units) => {
          for (const u of units) {
            const t = (groups[u.tbl === "ent" ? `ent:${u.k.slice(0, u.k.indexOf("\t"))}` : u.tbl] ??= newTally());
            t.store++;
            const mine = u.tbl === "ev" ? this.store.eventAt(Number(u.k)) : this.store.unit(u.tbl, u.k);
            if (sameValue(mine, u.value)) t.same++;
            else if (u.tbl !== "ev" && d.has(u.tbl, u.k)) t.moving++;
            else if (mine === null) t.extra++;
            else t.differ++;
          }
        },
        { from, maxPages: 2 },
      );
      return json({ groups, done: r.done, cursor: r.cursor, here: from ? undefined : this.store.counts(), pending: d.count(), eventsAhead: from ? undefined : Math.max(0, this.store.events(this.store.eventMark(), 100_000).length) });
    } catch (err) {
      return fail(502, "store_unreachable", `The permanent store could not be read: ${errText(err).slice(0, 160)}`);
    }
  }

  /** Copies what has changed to the store, in the background. Anything not accepted stays noted and is sent again. */
  private vaultSoon(): void {
    if (!this.dirty || this.destroyed || !this.owner || !this.runId) return;
    this.ctx.waitUntil(this.vaultFlush());
  }

  private async vaultFlush(): Promise<void> {
    await this.gate();
    const d = this.dirty;
    if (!d || this.destroyed || this.standby || !this.held || this.store.kvGet("vault:restoring")) return;
    this.mirror ??= new Mirror(this.env, `run:${this.runId}`, d, this.store, () => (this.standby || this.destroyed ? null : this.held));
    const r = await this.mirror.flush();
    if (r === "standby") {
      // The store refused: the work has moved to another copy of the site. Stop here and look again shortly.
      this.setStandby(true);
      this.gateAt = Date.now();
    } else if (r === "error" && !this.destroyed) {
      this.retry ??= setTimeout(() => {
        this.retry = null;
        this.vaultSoon();
      }, 30_000);
      // The alarm brings the object back to try again even if it is unloaded in the meantime.
      if (!this.alarmAt) {
        this.alarmAt = Date.now() + 60_000;
        try {
          await this.ctx.storage.setAlarm(this.alarmAt);
        } catch {
          this.alarmAt = 0;
        }
      }
    }
  }

  private ensure(): Engine | null {
    if (this.engine) return this.engine;
    if (this.destroyed) return null;
    if (this.dirty && this.store.kvGet("vault:restoring")) return null;
    const meta = this.store.kvGet<{ id: string; owner: string }>("meta");
    if (!meta) return null;
    this.runId = meta.id;
    this.owner = meta.owner;
    const e = this.build();
    if (!e.load()) return null;
    this.engine = e;
    // A run that was working when this object was last unloaded picks up where it stopped.
    if (e.run.status === "running" && !this.standby) void this.wake(0);
    this.vaultSoon();
    return e;
  }

  private async wake(delayMs: number): Promise<void> {
    if (this.destroyed) return;
    const now = Date.now();
    const at = now + Math.max(0, Math.min(delayMs, 3_600_000));
    if (!this.timer || at < this.timerAt - 5) {
      if (this.timer) clearTimeout(this.timer);
      this.timerAt = at;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.tick();
      }, at - now);
    }
    // The alarm is the safety net: it brings the object back if it is unloaded while it waits.
    if (this.alarmAt < at || this.alarmAt > at + 2 * WATCHDOG_MS) {
      this.alarmAt = at + WATCHDOG_MS;
      try {
        await this.ctx.storage.setAlarm(this.alarmAt);
      } catch {
        this.alarmAt = 0;
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.destroyed || this.standby) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        const e = this.ensure();
        if (!e) break;
        await e.tick();
      } while (this.again && !this.destroyed);
    } catch (err) {
      console.error("tick failed:", errText(err).slice(0, 300));
    } finally {
      this.ticking = false;
      this.vaultSoon();
    }
  }

  async alarm(): Promise<void> {
    this.alarmAt = 0;
    const st = this.dirty ? this.store.kvGet<Restoring | true>("vault:restoring") : undefined;
    if (st) {
      // Part of the way through reading this run back from the store: do the next step.
      if (typeof st === "object") {
        this.runId ||= st.id;
        this.owner ||= st.owner;
      }
      await this.gate(true);
      if (this.engine) await this.report();
      this.vaultSoon();
      return;
    }
    await this.tick();
    if (this.standby) {
      this.ensure();
      this.gateAt = 0;
      this.vaultSoon();
    }
  }

  // ---------- Budget and the project list ----------
  /** Asks the workspace to set aside this run's spending limit under the monthly ceiling. Returns why not, or null. */
  private async grant(e: Engine): Promise<string | null> {
    const run = e.run;
    let out: Record<string, unknown> = {};
    try {
      const res = await this.workspace("POST", "/internal/grant", { runId: this.runId, limitUsd: run.config.limits.spendUsd, spentUsd: run.spend.usd, reservedUsd: run.spend.reservedUsd });
      out = rec(await res.json().catch(() => ({})));
    } catch {
      out = {};
    }
    if (out.ok !== true) return typeof out.reason === "string" ? out.reason : "The workspace could not confirm the budget for this run, so it was not started.";
    if (out.clamped === true && typeof out.limitUsd === "number") {
      e.updateConfig({ limits: { spendUsd: out.limitUsd } });
      e.event("warn", "budget", `This run's spending limit was set to ${fmtUsd(out.limitUsd)}, which is what is left under the monthly ceiling.`);
    }
    return null;
  }

  private queueReport(_s?: RunSummary): void {
    if (this.reportTimer || this.destroyed) return;
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null;
      void this.report();
    }, REPORT_MS);
  }

  private async report(): Promise<void> {
    const e = this.engine;
    if (!e || this.destroyed) return;
    const run = e.run;
    const now = { written: this.store.written, read: this.store.read, calls: this.calls };
    const usage = { written: now.written - this.reported.written, read: now.read - this.reported.read, calls: now.calls - this.reported.calls };
    const vault = this.dirty ? { pending: this.dirty.count(), at: this.mirror?.lastOkAt ?? 0, error: this.mirror?.error ?? "" } : undefined;
    const body = { summary: e.summary(), ledger: { limitUsd: run.config.limits.spendUsd, spentUsd: run.spend.usd, reservedUsd: run.spend.reservedUsd, active: run.status === "running" }, usage, vault };
    this.vaultSoon();
    const sig = JSON.stringify([body.summary, body.ledger]);
    if (sig === this.lastSig && usage.written + usage.calls < 200 && usage.read < 20_000) return;
    try {
      const res = await this.workspace("POST", "/internal/report", body);
      if (!res.ok) return;
      this.lastSig = sig;
      this.reported = now;
      const out = rec(await res.json().catch(() => ({})));
      if (typeof out.clampTo === "number") {
        const to = Math.max(1, out.clampTo);
        e.updateConfig({ limits: { spendUsd: to } });
        e.event("warn", "budget", `This run's spending limit was lowered to ${fmtUsd(to)} to stay inside the monthly ceiling.`);
        if (out.clampTo < 1 && run.status === "running") e.pauseRun("The monthly spending ceiling has been reached. Raise it in Settings to continue.", true);
      }
      if (out.ungranted === true && run.status === "running") {
        const denied = await this.grant(e);
        if (denied) e.pauseRun(denied, true);
      }
      if (typeof out.pause === "string" && out.pause && run.status === "running") e.pauseRun(out.pause, true);
    } catch {
      // The next report retries.
    }
  }

  // ---------- Live viewers ----------
  private broadcast(msg: ServerMsg): void {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    let text = JSON.stringify(msg);
    if (text.length > BIG) {
      if (msg.t !== "put") return;
      text = JSON.stringify({ t: "big", kind: msg.kind, id: msg.id } satisfies ServerMsg);
    }
    for (const ws of sockets) {
      try {
        ws.send(text);
      } catch {
        // The viewer has gone.
      }
    }
  }

  /** Sends the whole current state to one viewer, in pieces small enough for a live message. */
  private sync(ws: WebSocket, e: Engine): void {
    const raw = (text: string): void => {
      try {
        ws.send(text);
      } catch {
        // The viewer has gone.
      }
    };
    raw(JSON.stringify({ t: "snapshot", entities: {}, events: this.store.loadEvents(300) } satisfies ServerMsg));
    const snap = e.publicSnapshot();
    let parts: string[] = [];
    let size = 0;
    const flush = (): void => {
      if (parts.length) raw(`{"t":"batch","items":[${parts.join(",")}]}`);
      parts = [];
      size = 0;
    };
    for (const kind of ENTITY_KINDS) {
      for (const data of (snap[kind] ?? []) as { id: string }[]) {
        const item = JSON.stringify({ kind, id: data.id, data });
        if (item.length > BIG) {
          raw(JSON.stringify({ t: "big", kind, id: data.id } satisfies ServerMsg));
          continue;
        }
        if (size + item.length > BATCH) flush();
        parts.push(item);
        size += item.length + 1;
      }
    }
    flush();
    raw('{"t":"ready"}');
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 2000) return;
    let m: Record<string, unknown>;
    try {
      m = rec(JSON.parse(message));
    } catch {
      return;
    }
    if (m.t !== "sync") return;
    const e = this.ensure();
    if (e) this.sync(ws, e);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    if (code === 1006 || code === 1015) return;
    try {
      if (code === 1005) ws.close();
      else ws.close(code, "closed");
    } catch {
      // Already closed.
    }
  }

  async webSocketError(): Promise<void> {
    // Nothing to clean up: the runtime drops the socket.
  }

  // ---------- Requests from the router ----------
  async fetch(request: Request): Promise<Response> {
    this.calls++;
    if (this.destroyed || !(await fromInside(request, this.env))) return notFound();
    const owner = request.headers.get("x-scholium-owner") ?? "";
    if (!owner) return notFound();
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (method === "POST" && path === "/internal/init") return await this.init(request, owner);
      if (method === "POST" && path === "/internal/vault/kick") return await this.kick(request, owner);
      let e = this.ensure();
      if (this.dirty && method !== "GET" && e && owner === this.owner) {
        // Nothing is changed on a copy of the site that is on standby; and a run is brought up to date before it is changed.
        await this.gate();
        if (this.standby) return fail(409, "standby", STANDBY);
        e = this.ensure();
      }
      // A run that belongs to someone else looks exactly like a run that does not exist.
      if (!e || owner !== this.owner) return notFound();
      const res = await this.route(e, request, url, method, path);
      if (method !== "GET") this.vaultSoon();
      return res;
    } catch (err) {
      console.error("run request failed:", method, path, errText(err).slice(0, 300));
      return fail(500, "server_error", "The run could not complete this request.");
    }
  }

  /** The workspace asks the run to line itself up with the store: after the work moved to this copy, or to try again. */
  private async kick(request: Request, owner: string): Promise<Response> {
    const body = await readBody(request);
    const id = String(body.id ?? "");
    if (!/^[a-z0-9]{16,40}$/.test(id)) return fail(400, "bad_request", "No run was named.");
    const meta = this.store.kvGet<{ id: string; owner: string }>("meta");
    if (meta && (meta.id !== id || meta.owner !== owner)) return notFound();
    this.runId = id;
    this.owner = owner;
    // Kept on this copy until the run is all here, however many steps reading it back takes.
    if (body.resume === true) this.store.kvSet("vault:resume", true);
    await this.gate(true);
    if (this.standby) this.store.kvDel("vault:resume");
    const e = this.ensure();
    const st = this.store.kvGet<Restoring | true>("vault:restoring");
    if (st) return json({ ok: true, standby: this.standby, restoring: true, units: typeof st === "object" ? st.n : 0 });
    if (this.held && !this.standby && !e) return fail(502, "not_restored", "This run could not be read back from the store yet.");
    if (e) await this.resumeAfterMove();
    if (e) await this.report();
    this.vaultSoon();
    return json({ ok: true, standby: this.standby });
  }

  private async init(request: Request, owner: string): Promise<Response> {
    if (this.store.kvGet("meta")) return fail(409, "exists", "This run already exists.");
    const b = await readBody(request);
    const id = String(b.id ?? "");
    if (!/^[a-z0-9]{16,40}$/.test(id)) return fail(400, "bad_request", "The run could not be created.");
    if (this.dirty) {
      this.owner = owner;
      this.runId = id;
      await this.gate(true);
      if (this.standby) return fail(409, "standby", STANDBY);
    }
    const from = rec(b.branchedFrom);
    let imported: CheckpointExport | undefined;
    let branchedFrom: { runId: string; checkpointId: string } | undefined;
    if (typeof from.runId === "string" && typeof from.checkpointId === "string") {
      const res = await callObject(this.env.RUN, `run:${from.runId}`, this.env, owner, "GET", `/internal/checkpoints/${from.checkpointId}`);
      if (!res.ok) return fail(404, "not_found", "That checkpoint could not be found.");
      imported = (await res.json()) as CheckpointExport;
      branchedFrom = { runId: from.runId, checkpointId: from.checkpointId };
    }
    // A run brought over from an earlier Scholium site starts from that run's latest checkpoint, exactly as a branch does.
    const rem = rec(b.remote);
    const remote = typeof rem.base === "string" && OLD_SITES.includes(rem.base) && oldSitePass(rem.token) && /^[a-z0-9]{16,40}$/.test(String(rem.runId)) ? { base: rem.base, token: oldSitePass(rem.token), runId: String(rem.runId) } : undefined;
    if (remote && !imported) {
      const got = await this.remoteCheckpoint(remote);
      if (typeof got === "string") return fail(409, "refused", got);
      imported = got;
    }
    // A run restored from a backup file starts from the ledger saved in that file.
    const archive = !imported && b.archive !== undefined ? readBackup(b.archive) : null;
    if (b.archive !== undefined && !imported && !archive) return fail(400, "bad_backup", "This file is not a Scholium backup, or it is damaged.");
    if (archive) imported = archive.checkpoint;
    this.owner = owner;
    this.runId = id;
    const e = this.build();
    try {
      e.init({ id, ownerHash: owner, config: b.config ?? imported?.config, origin: typeof b.origin === "string" ? b.origin : undefined, import: imported, branchedFrom });
    } catch (err) {
      return fail(400, "bad_config", errText(err).slice(0, 300));
    }
    this.store.kvSet("meta", { id, owner });
    this.engine = e;
    if (imported && branchedFrom) await this.pull(e, branchedFrom.runId, imported);
    if (imported && remote) await this.pullRemote(e, remote, imported);
    if (archive) {
      for (const [sid, text] of Object.entries(archive.texts)) e.importText(sid, text);
      for (const [uid, b64] of Object.entries(archive.files)) {
        const bytes = fromBase64(b64);
        if (bytes) e.importBlob(uid, bytes);
      }
    }
    e.flush();
    await this.report();
    this.vaultSoon();
    return json({ id, run: e.publicRun() }, 201);
  }

  /** Copies the source texts and uploaded files a branch inherits from the run it was branched from. */
  private async pull(e: Engine, fromRun: string, imp: CheckpointExport): Promise<void> {
    const src = (method: string, path: string, body?: unknown): Promise<Response> => callObject(this.env.RUN, `run:${fromRun}`, this.env, this.owner, method, path, body);
    let ids = (imp.entities.source ?? []).map((s) => s.id);
    for (let guard = 0; ids.length && guard < 200; guard++) {
      try {
        const r = await src("POST", "/internal/pull-texts", { ids });
        if (!r.ok) break;
        const out = rec(await r.json());
        for (const [sid, text] of Object.entries(rec(out.texts))) if (typeof text === "string" && text) e.importText(sid, text);
        ids = Array.isArray(out.rest) ? out.rest.map(String) : [];
      } catch {
        break;
      }
    }
    for (const u of imp.entities.upload ?? []) {
      try {
        const r = await src("GET", `/internal/pull-blob/${u.id}`);
        if (r.ok) e.importBlob(u.id, new Uint8Array(await r.arrayBuffer()));
      } catch {
        // The branch still has the upload's extracted text; only the original file is missing.
      }
    }
  }

  /** Reads the latest checkpoint of a run on an earlier Scholium site. Returns a sentence to show when it cannot. */
  private async remoteCheckpoint(r: RemoteRun): Promise<CheckpointExport | string> {
    const get = (path: string): Promise<Response> => fetch(`${r.base}/api/runs/${r.runId}${path}`, { headers: { authorization: `Bearer ${r.token}` }, signal: AbortSignal.timeout(30_000) });
    try {
      const snap = await get("");
      if (snap.status === 401 || snap.status === 403) return "The old site did not accept that pass. It lasts about an hour: copy a new one and try again.";
      if (!snap.ok) return "That run could not be found on the old site.";
      const list = rec(rec(await snap.json()).entities).checkpoint;
      const latest = (Array.isArray(list) ? list.map(rec) : []).filter((c) => typeof c.id === "string").sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))[0];
      if (!latest) return "That run has no saved checkpoint yet, so there is nothing to bring over.";
      const res = await get(`/checkpoints/${encodeURIComponent(String(latest.id))}`);
      if (!res.ok) return "The old site could not hand over that run's checkpoint.";
      const data = (await res.json()) as CheckpointExport;
      if (!data || typeof data !== "object" || !data.config || !data.entities || typeof data.entities !== "object") return "The old site's checkpoint could not be read.";
      return data;
    } catch {
      return "The old site could not be reached. Try again in a moment.";
    }
  }

  /** Copies the source texts and uploaded files of a run brought over from an earlier site. What cannot be fetched is skipped. */
  private async pullRemote(e: Engine, r: RemoteRun, imp: CheckpointExport): Promise<void> {
    const get = (path: string): Promise<Response> => fetch(`${r.base}/api/runs/${r.runId}${path}`, { headers: { authorization: `Bearer ${r.token}` }, signal: AbortSignal.timeout(30_000) });
    const ids = (imp.entities.source ?? []).map((s) => s.id).slice(0, 600);
    for (let i = 0; i < ids.length; i += 6) {
      await Promise.all(
        ids.slice(i, i + 6).map(async (sid) => {
          try {
            const res = await get(`/text?ref=${encodeURIComponent(sid)}`);
            const text = res.ok ? rec(await res.json()).text : undefined;
            if (typeof text === "string" && text) e.importText(sid, text);
          } catch {
            // The run still has the source's record; only its full text is missing.
          }
        }),
      );
    }
    for (const u of (imp.entities.upload ?? []).slice(0, 30)) {
      try {
        const res = await get(`/uploads/${encodeURIComponent(u.id)}/file`);
        if (res.ok) e.importBlob(u.id, new Uint8Array(await res.arrayBuffer()));
      } catch {
        // The run still has the upload's extracted text; only the original file is missing.
      }
    }
  }

  private async route(e: Engine, request: Request, url: URL, method: string, path: string): Promise<Response> {
    const done = (r: ActionResult & Record<string, unknown>, status = 200): Response => {
      if (!r.ok) return fail(409, "refused", r.error);
      this.queueReport();
      void this.tick();
      return json(r, status);
    };
    const q = (k: string): string => url.searchParams.get(k) ?? "";
    let m: RegExpExecArray | null;

    if (method === "GET") {
      if (path === "/internal/vault/check") return this.checkStore(q("at"));
      if (path === "/internal/exists") return json({ ok: true });
      if (path === "/internal/backup") return json(buildBackup(e));
      if (path === "/internal/snapshot") return json({ entities: e.publicSnapshot(), events: this.store.loadEvents(300) });
      if (path === "/internal/calls") return json({ calls: e.calls() });
      if (path === "/internal/text") {
        const text = e.text(q("ref").slice(0, 200));
        return text === null ? notFound() : json({ ref: q("ref").slice(0, 200), text });
      }
      if (path === "/internal/search") return json({ hits: q("q").trim() ? e.search(q("q").slice(0, 300), 40) : [] });
      if (path === "/internal/export") {
        const f = q("format");
        return f === "md" || f === "tex" || f === "json" ? json(e.export(f)) : fail(400, "bad_request", "Choose md, tex or json.");
      }
      if (path === "/internal/entity") {
        const kind = q("kind");
        if (!(ENTITY_KINDS as string[]).includes(kind)) return notFound();
        const data = kind === "run" ? e.publicRun() : (e.m[kind as EntityKind] as Map<string, unknown>).get(q("id"));
        return data ? json({ kind, id: q("id"), data }) : notFound();
      }
      if (path === "/internal/ws") return this.openSocket(e, request);
      if ((m = new RegExp(`^/internal/uploads/${ID}/file$`).exec(path))) {
        const up = e.m.upload.get(m[1]);
        const bytes = e.uploadBytes(m[1]);
        if (!up || !bytes) return notFound();
        // Uploaded files are untrusted: always a download, never something the browser renders.
        return new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-disposition": attachment(up.name) } });
      }
      if ((m = new RegExp(`^/internal/tasks/${ID}/messages$`).exec(path))) {
        const t = e.transcript(m[1]);
        if (!t) return notFound();
        const msgs = t.msgs.map((msg) => {
          const c: Record<string, unknown> = { ...msg };
          delete c.raw;
          return c;
        });
        return json({ task: t.task, msgs });
      }
      if ((m = new RegExp(`^/internal/checkpoints/${ID}$`).exec(path))) {
        const cp = e.exportCheckpoint(m[1]);
        return cp ? json(cp) : notFound();
      }
      if ((m = new RegExp(`^/internal/pull-blob/${ID}$`).exec(path))) {
        const bytes = e.uploadBytes(m[1]);
        return bytes ? new Response(bytes, { headers: { "content-type": "application/octet-stream" } }) : notFound();
      }
      return notFound();
    }

    if (method === "POST" && path === "/internal/uploads") {
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return fail(400, "bad_request", "The upload could not be read.");
      }
      const file = form.get("file");
      if (!file || typeof file === "string") return fail(400, "bad_request", "Choose a file to upload.");
      const text = form.get("text");
      const pages = Number(form.get("pages") ?? "");
      const r = await e.addUpload({
        name: file.name.slice(0, 200),
        mime: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
        text: typeof text === "string" && text ? text.slice(0, 2_000_000) : undefined,
        pages: Number.isFinite(pages) && pages > 0 ? Math.floor(pages) : undefined,
      });
      return done(r, 201);
    }

    const b = method === "DELETE" ? {} : await readBody(request);

    if (method === "POST" && path === "/internal/action") {
      const kind = String(b.kind ?? "");
      if (kind !== "start" && kind !== "pause" && kind !== "resume" && kind !== "stop") return fail(400, "bad_request", "Unknown action.");
      if (kind === "start" || kind === "resume") {
        const denied = await this.grant(e);
        if (denied) return fail(409, "budget", denied);
      }
      const r = await e.action(kind);
      return done(r.ok ? { ok: true, run: e.publicRun() } : r);
    }
    if (method === "PUT" && path === "/internal/config") {
      const before = e.run.config.limits.spendUsd;
      const r = e.updateConfig(b.config ?? b);
      if (r.ok && e.run.status === "running" && e.run.config.limits.spendUsd > before) {
        const denied = await this.grant(e);
        if (denied) {
          e.updateConfig({ limits: { spendUsd: before } });
          return fail(409, "budget", denied);
        }
      }
      return done(r.ok ? { ok: true, run: e.publicRun() } : r);
    }
    if (method === "POST" && path === "/internal/instructions") return done(e.addInstruction(String(b.body ?? "").slice(0, 20_000), typeof b.target === "string" ? b.target.slice(0, 64) : "all"), 201);
    if (method === "POST" && path === "/internal/instructions/reorder") return done(e.reorderInstructions(Array.isArray(b.ids) ? b.ids.map(String).slice(0, 500) : []));
    if ((m = new RegExp(`^/internal/instructions/${ID}$`).exec(path))) {
      if (method === "PUT") return done(e.editInstruction(m[1], String(b.body ?? "").slice(0, 20_000)));
      if (method === "DELETE") return done(e.cancelInstruction(m[1]));
    }
    if (method === "POST" && path === "/internal/pull-texts") {
      const texts: Record<string, string> = {};
      const rest: string[] = [];
      let size = 0;
      for (const id of Array.isArray(b.ids) ? b.ids.map(String) : []) {
        if (size > 3_000_000) {
          rest.push(id);
          continue;
        }
        texts[id] = e.sourceText(id);
        size += texts[id].length;
      }
      return json({ texts, rest });
    }
    if (method === "POST" && path === "/internal/destroy") return this.destroy(e);
    return notFound();
  }

  private openSocket(e: Engine, request: Request): Response {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return fail(426, "upgrade_required", "This address only accepts a live connection.");
    // Each ticket opens one connection, once.
    const nonce = request.headers.get("x-scholium-nonce") ?? "";
    if (!nonce || this.store.kvGet(`nonce:${nonce}`) !== undefined) return fail(401, "invalid_ticket", "This live connection was not authorised. Request a new ticket.");
    const now = Date.now();
    for (const old of this.store.kvPrefix<number>("nonce:")) if (now - old.v > 4 * WS_TICKET_TTL_MS) this.store.kvDel(old.k);
    this.store.kvSet(`nonce:${nonce}`, now);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    this.sync(pair[1], e);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async destroy(e: Engine): Promise<Response> {
    try {
      await e.action("stop");
    } catch {
      // Being deleted regardless.
    }
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.timer = this.reportTimer = null;
    await Promise.race([e.idle(), new Promise((r) => setTimeout(r, 4000))]);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4001, "This run was deleted.");
      } catch {
        // Already closed.
      }
    }
    this.engine = null;
    if (this.retry) clearTimeout(this.retry);
    // A deleted project is removed from the store as well.
    if (this.held && !this.standby) await dropObject(this.env, this.held, `run:${this.runId}`).catch(() => undefined);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return json({ ok: true });
  }
}
