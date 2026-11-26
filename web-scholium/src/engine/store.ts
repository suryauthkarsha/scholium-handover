import type { ActivityEvent, EntityKind, Msg } from "../shared/types";
import { keyTerms } from "./util";

export interface SearchHit {
  ref: string;
  kind: string;
  title: string;
  snippet: string;
  score: number;
}

export interface StoredEntity {
  kind: EntityKind;
  id: string;
  data: unknown;
}

/**
 * Durable storage behind a run. Synchronous, because Durable Object SQLite is.
 * The engine keeps entities in memory and writes through this interface.
 */
export interface Store {
  loadEntities(): StoredEntity[];
  putEntity(kind: EntityKind, id: string, data: unknown): void;
  delEntity(kind: EntityKind, id: string): void;
  loadMsgs(taskId: string): Msg[];
  /** Writes msgs at positions from..from+n-1 and drops anything after them. */
  writeMsgs(taskId: string, from: number, msgs: Msg[]): void;
  appendEvent(e: ActivityEvent): void;
  loadEvents(limit: number): ActivityEvent[];
  putText(ref: string, text: string): void;
  /** The same as putText for a long text handed over in pieces. A store without it is given the whole text. */
  putTextFrom?(ref: string, pieces: Iterable<string>): void;
  getText(ref: string): string | null;
  putBlob(ref: string, bytes: Uint8Array): void;
  getBlob(ref: string): Uint8Array | null;
  indexDoc(ref: string, kind: string, title: string, text: string): void;
  search(query: string, limit: number, kinds?: string[]): SearchHit[];
  transaction(fn: () => void): void;
}

interface Doc {
  kind: string;
  title: string;
  text: string;
}

/** In-memory store used by tests and local tooling. */
export class MemoryStore implements Store {
  ents = new Map<string, StoredEntity>();
  msgs = new Map<string, string[]>();
  events: ActivityEvent[] = [];
  texts = new Map<string, string>();
  blobs = new Map<string, Uint8Array>();
  docs = new Map<string, Doc>();
  writes = 0;

  loadEntities(): StoredEntity[] {
    return [...this.ents.values()].map((e) => ({ ...e, data: JSON.parse(JSON.stringify(e.data)) }));
  }
  putEntity(kind: EntityKind, id: string, data: unknown): void {
    this.writes++;
    this.ents.set(`${kind}\u0000${id}`, { kind, id, data: JSON.parse(JSON.stringify(data)) });
  }
  delEntity(kind: EntityKind, id: string): void {
    this.ents.delete(`${kind}\u0000${id}`);
  }
  loadMsgs(taskId: string): Msg[] {
    return (this.msgs.get(taskId) ?? []).map((m) => JSON.parse(m) as Msg);
  }
  writeMsgs(taskId: string, from: number, msgs: Msg[]): void {
    const cur = (this.msgs.get(taskId) ?? []).slice(0, from);
    for (const m of msgs) cur.push(JSON.stringify(m));
    this.msgs.set(taskId, cur);
  }
  appendEvent(e: ActivityEvent): void {
    this.events.push(e);
  }
  loadEvents(limit: number): ActivityEvent[] {
    return this.events.slice(-limit);
  }
  putText(ref: string, text: string): void {
    this.texts.set(ref, text);
  }
  getText(ref: string): string | null {
    return this.texts.get(ref) ?? null;
  }
  putBlob(ref: string, bytes: Uint8Array): void {
    this.blobs.set(ref, bytes);
  }
  getBlob(ref: string): Uint8Array | null {
    return this.blobs.get(ref) ?? null;
  }
  indexDoc(ref: string, kind: string, title: string, text: string): void {
    this.docs.set(ref, { kind, title, text });
  }
  search(query: string, limit: number, kinds?: string[]): SearchHit[] {
    const terms = keyTerms(query);
    if (!terms.length) return [];
    const hits: SearchHit[] = [];
    for (const [ref, d] of this.docs) {
      if (kinds?.length && !kinds.includes(d.kind)) continue;
      const hay = `${d.title} ${d.text}`.toLowerCase();
      let score = 0;
      let first = -1;
      for (const t of terms) {
        const at = hay.indexOf(t);
        if (at >= 0) {
          score++;
          if (first < 0 || at < first) first = at;
        }
      }
      if (!score) continue;
      const from = Math.max(0, first - d.title.length - 60);
      hits.push({ ref, kind: d.kind, title: d.title, snippet: d.text.slice(from, from + 240), score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  transaction(fn: () => void): void {
    fn();
  }
}
