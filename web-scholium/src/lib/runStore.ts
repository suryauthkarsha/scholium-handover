// The live state of one run. It is loaded over the API and then kept current by the run's own stream of
// changes. Nothing shown on the run screen is invented by the browser: every figure comes from these messages.
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { dataFrom, type Data } from "@/engine/report";
import { api, ApiError, errorText, socketUrl } from "@/lib/api";
import { ENTITY_KINDS, type ActivityEvent, type EntityKind, type EntityMap, type RunState, type ServerMsg, type Snapshot } from "@/shared/types";

export type Link = "connecting" | "live" | "reconnecting" | "ended";

/** Text a model is producing right now, before the turn is saved. */
export interface Stream {
  taskId: string;
  agentId: string;
  text: string;
  thinking: string;
  at: number;
}

interface Meta {
  loaded: boolean;
  link: Link;
  /** Why the run cannot be shown at all. */
  fatal?: string;
  /** Why the live connection is down, in the server's or the browser's own words. */
  linkNote?: string;
}

export interface RunView extends Meta {
  data: Data;
  run?: RunState;
  events: ActivityEvent[];
  streams: Stream[];
}

type Row = { id: string } & Record<string, unknown>;
type Maps = Record<EntityKind, Map<string, Row>>;

const MAX_EVENTS = 800;
const MAX_STREAM = 16_000;
const GONE = "This project does not exist. It may have been deleted.";

/** Close codes that mean "do not come back": a refused ticket, or a deleted run. */
const final = (code: number): boolean => code === 1008 || (code >= 4000 && code < 4100);

function newMaps(): Maps {
  const m = {} as Maps;
  for (const k of ENTITY_KINDS) m[k] = new Map();
  return m;
}

function fill(maps: Maps, snap: Snapshot | undefined): void {
  for (const k of ENTITY_KINDS) for (const row of (snap?.[k] ?? []) as unknown as Row[]) maps[k].set(row.id, row);
}

function stamp(r: Row): number {
  const v = r.createdAt ?? r.at ?? r.addedAt ?? r.retrievedAt;
  return typeof v === "number" ? v : 0;
}
const num = (id: string): number => Number(id.replace(/\D+/g, "")) || 0;
const order = (a: Row, b: Row): number => stamp(a) - stamp(b) || num(a.id) - num(b.id) || (a.id < b.id ? -1 : 1);

export class RunStore {
  private maps = newMaps();
  /** A full resend is collected here and swapped in when complete, so the screen never flashes empty. */
  private staging: Maps | null = null;
  private stagedEvents: ActivityEvent[] = [];
  private dirty = new Set<EntityKind>();
  private events: ActivityEvent[] = [];
  private streams = new Map<string, Stream>();
  private touched = { events: false, streams: false };
  private listeners = new Set<() => void>();
  private meta: Meta = { loaded: false, link: "connecting" };
  private view: RunView = { ...this.meta, data: dataFrom({}), events: [], streams: [] };

  private ws: WebSocket | null = null;
  private asking = false;
  private stopped = true;
  private everLive = false;
  private attempt = 0;
  private gen = 0;
  private heard = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly id: string) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  get = (): RunView => this.view;

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const gen = ++this.gen;
    window.addEventListener("online", this.wake);
    document.addEventListener("visibilitychange", this.wake);
    void this.load(gen);
    void this.connect(gen);
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    this.asking = false;
    window.removeEventListener("online", this.wake);
    document.removeEventListener("visibilitychange", this.wake);
    clearTimeout(this.retryTimer);
    clearTimeout(this.flushTimer);
    clearInterval(this.pingTimer);
    this.retryTimer = this.flushTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000);
    } catch {
      // Already closed.
    }
  }

  /** Asks the server to send everything again, or reconnects if the stream is down. */
  resync = (): void => {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('{"t":"sync"}');
    else this.reconnect(true);
  };

  /** Shows a server answer at once; the stream confirms it a moment later. */
  apply<K extends EntityKind>(kind: K, row: EntityMap[K] | undefined): void {
    if (row) this.put(kind, row.id, row);
  }

  private wake = (): void => {
    if (document.visibilityState === "visible") this.reconnect(false);
  };

  private reconnect(forced: boolean): void {
    if (this.stopped || this.ws || this.asking || this.meta.fatal) return;
    if (this.meta.link === "ended" && !forced) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (forced) this.attempt = 0;
    void this.connect(this.gen);
  }

  /** The whole state over the API: the first paint, and the fallback while the stream is down. */
  private async load(gen: number): Promise<void> {
    try {
      const snap = await api.snapshot(this.id);
      if (gen !== this.gen || this.meta.link === "live") return;
      const maps = newMaps();
      fill(maps, snap.entities);
      this.maps = maps;
      for (const k of ENTITY_KINDS) this.dirty.add(k);
      this.addEvents(snap.events ?? []);
      this.patch({ loaded: true });
    } catch (e) {
      if (gen !== this.gen) return;
      if (e instanceof ApiError && e.status === 404) this.end(GONE, true);
      else if (!this.meta.loaded) this.patch({ linkNote: errorText(e) });
    }
  }

  private async connect(gen: number): Promise<void> {
    if (this.stopped || this.asking || this.ws || gen !== this.gen) return;
    this.asking = true;
    this.patch({ link: this.everLive || this.attempt > 0 ? "reconnecting" : "connecting" });
    let ticket: string;
    try {
      // Every connection needs its own single-use ticket, issued only to the signed-in owner.
      ticket = (await api.wsTicket(this.id)).ticket;
    } catch (e) {
      if (gen !== this.gen) return;
      this.asking = false;
      if (e instanceof ApiError && e.status === 404) return this.end(GONE, true);
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return this.end(e.message);
      return this.retry(gen, errorText(e));
    }
    if (gen !== this.gen) return;
    this.asking = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl(this.id, ticket));
    } catch (e) {
      return this.retry(gen, errorText(e));
    }
    this.ws = ws;
    this.heard = Date.now();
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.heard = Date.now();
      if (typeof ev.data === "string" && ev.data !== "pong") this.receive(ev.data);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.staging = null;
      clearInterval(this.pingTimer);
      if (final(ev.code)) this.end(ev.reason || "The server closed the live connection.", ev.code === 4001);
      else this.retry(gen, ev.reason || "The live connection dropped.");
    };
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws) return;
      if (Date.now() - this.heard > 70_000) {
        // Silent for too long: treat it as dead rather than show stale state as live.
        try {
          ws.close();
        } catch {
          // Already closed.
        }
      } else if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 25_000);
  }

  private retry(gen: number, why: string): void {
    if (gen !== this.gen || this.stopped) return;
    const wait = Math.min(30_000, 500 * 2 ** this.attempt) * (0.6 + Math.random() * 0.8);
    this.attempt++;
    this.patch({ link: "reconnecting", linkNote: why });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect(gen);
    }, wait);
    if (this.attempt >= 2) void this.load(gen);
  }

  private end(why: string, fatal = false): void {
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.retryTimer = undefined;
    this.patch(fatal ? { link: "ended", fatal: why } : { link: "ended", linkNote: why });
  }

  private receive(text: string): void {
    let m: ServerMsg;
    try {
      m = JSON.parse(text) as ServerMsg;
    } catch {
      return;
    }
    switch (m.t) {
      case "snapshot":
        this.staging = newMaps();
        fill(this.staging, m.entities);
        this.stagedEvents = m.events ?? [];
        break;
      case "batch":
        for (const it of m.items ?? []) this.put(it.kind, it.id, it.data);
        break;
      case "big":
        void this.fetchBig(m.kind, m.id);
        break;
      case "ready":
        if (this.staging) {
          this.maps = this.staging;
          this.staging = null;
          for (const k of ENTITY_KINDS) this.dirty.add(k);
          for (const taskId of [...this.streams.keys()]) if (this.maps.task.get(taskId)?.status !== "running") this.streams.delete(taskId);
          this.touched.streams = true;
          this.addEvents(this.stagedEvents);
          this.stagedEvents = [];
        }
        this.attempt = 0;
        this.everLive = true;
        this.patch({ loaded: true, link: "live", linkNote: undefined });
        break;
      case "put":
        this.put(m.kind, m.id, m.data);
        break;
      case "del":
        (this.staging ?? this.maps)[m.kind]?.delete(m.id);
        if (!this.staging) this.mark(m.kind);
        break;
      case "event":
        if (m.event) this.addEvents([m.event]);
        break;
      case "delta":
        this.delta(m.taskId, m.agentId, m.kind, m.text);
        break;
      case "error":
        this.patch({ linkNote: m.message });
        break;
    }
  }

  private put(kind: EntityKind, id: string, data: unknown): void {
    const map = (this.staging ?? this.maps)[kind];
    if (!map || !data || typeof data !== "object") return;
    if (kind === "task" && this.streams.has(id)) {
      // Once a turn is saved (or the task stops), its transcript replaces the text that was streaming.
      const before = this.maps.task.get(id);
      const now = data as { status?: string; msgCount?: number };
      if (now.status !== "running" || now.msgCount !== before?.msgCount) {
        this.streams.delete(id);
        this.touched.streams = true;
      }
    }
    map.set(id, data as Row);
    if (!this.staging) this.mark(kind);
  }

  private async fetchBig(kind: EntityKind, id: string): Promise<void> {
    const gen = this.gen;
    try {
      const got = await api.entity(this.id, kind, id);
      if (gen === this.gen) this.put(kind, id, got.data);
    } catch {
      // The next change to it, or the next full resend, brings it.
    }
  }

  private delta(taskId: string, agentId: string, kind: "text" | "thinking", text: string): void {
    if (!taskId || typeof text !== "string" || (kind !== "text" && kind !== "thinking")) return;
    const s = this.streams.get(taskId) ?? { taskId, agentId, text: "", thinking: "", at: 0 };
    const next = s[kind] + text;
    s[kind] = next.length > MAX_STREAM ? next.slice(-MAX_STREAM) : next;
    s.at = Date.now();
    this.streams.set(taskId, s);
    this.touched.streams = true;
    this.schedule();
  }

  private addEvents(list: ActivityEvent[]): void {
    if (!list.length) return;
    const bySeq = new Map(this.events.map((e) => [e.seq, e]));
    for (const e of list) bySeq.set(e.seq, e);
    const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    this.events = all.length > MAX_EVENTS ? all.slice(-MAX_EVENTS) : all;
    this.touched.events = true;
    this.schedule();
  }

  private mark(kind: EntityKind): void {
    this.dirty.add(kind);
    this.schedule();
  }

  private patch(meta: Partial<Meta>): void {
    this.meta = { ...this.meta, ...meta };
    this.schedule();
  }

  private schedule(): void {
    if (this.flushTimer === undefined && !this.stopped) this.flushTimer = setTimeout(this.flush, 70);
  }

  /** Builds the next immutable view. Lists of kinds that did not change keep their identity, so screens can skip work. */
  private flush = (): void => {
    this.flushTimer = undefined;
    let data = this.view.data;
    if (this.dirty.size) {
      const next = { ...data } as unknown as Record<EntityKind, Row[]>;
      for (const k of this.dirty) next[k] = [...this.maps[k].values()].sort(order);
      this.dirty.clear();
      data = next as unknown as Data;
    }
    this.view = {
      ...this.meta,
      data,
      run: data.run[0],
      events: this.touched.events ? [...this.events] : this.view.events,
      streams: this.touched.streams ? [...this.streams.values()].map((s) => ({ ...s })) : this.view.streams,
    };
    this.touched = { events: false, streams: false };
    for (const fn of [...this.listeners]) fn();
  };
}

export function useRun(id: string): { view: RunView; store: RunStore } {
  const store = useMemo(() => new RunStore(id), [id]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  const view = useSyncExternalStore(store.subscribe, store.get);
  return { view, store };
}
