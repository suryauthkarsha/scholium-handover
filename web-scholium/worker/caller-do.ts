// Helpers that make model calls on the run's behalf, so that hundreds can be in the air at once.
//
// One run lives in one object with a fixed amount of memory and a small number of open connections. Each helper is
// an object of its own with its own share of both: it builds the provider's request, holds the connection, reads
// the stream and hands back the finished answer. A helper keeps nothing; the run stays the only place work is saved.
import { DurableObject } from "cloudflare:workers";
import { createGateway, isAbort, LlmError, type Llm, type LlmRequest, type LlmResponse } from "../src/engine/providers";
import { errText } from "../src/engine/util";
import { modelAccount } from "../src/shared/modelAccount";
import { type Env, fromInside, INTERNAL, notFound, withMoveKey } from "./env";
import { internalKey } from "../src/shared/gate";

/** Calls the run makes itself, as it always has. Only what goes beyond this is handed to helpers. */
export const DIRECT_CALLS = 32;
/** The most calls in the air at once when helpers are available. */
export const POOLED_CALLS = 300;
/** Each helper holds at most a few calls, to stay inside its own connection allowance. */
const PER_HELPER = 4;
const HELPERS = Math.ceil(POOLED_CALLS / PER_HELPER) + 8;
const KEEPALIVE_MS = 10_000;
/** After this many helper failures in a row, helpers are left alone for a while and the run works at its own pace. */
const TRIP_AFTER = 5;
const TRIP_MS = 10 * 60_000;

type Wire = Pick<LlmRequest, "model" | "system" | "messages" | "tools" | "maxOutput" | "purpose">;
type Line = { d: ["text" | "thinking", string] } | { k: 1 } | { ok: LlmResponse } | { err: { message: string; status?: number; retryable: boolean; llm: boolean } };

export class ModelCaller extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const env = withMoveKey(this.env);
    if (!(await fromInside(request, env))) return notFound();
    const wire = (await request.json()) as Wire;
    const llm = createGateway({ secret: modelAccount(env).secret });
    const ac = new AbortController();
    request.signal?.addEventListener("abort", () => ac.abort());
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    let pending = "";
    let writing: Promise<void> = Promise.resolve();
    // The run going away (an interruption, a restart) shows as a failed write: the model call is stopped with it.
    const send = (l: Line): void => {
      pending += JSON.stringify(l) + "\n";
      writing = writing.then(async () => {
        if (!pending) return;
        const out = pending;
        pending = "";
        await writer.write(enc.encode(out));
      });
      writing.catch(() => ac.abort());
    };
    const beat = setInterval(() => send({ k: 1 }), KEEPALIVE_MS);
    const work = (async () => {
      try {
        const res = await llm.call({ ...wire, signal: ac.signal, onDelta: (kind, text) => send({ d: [kind, text] }) });
        send({ ok: res });
      } catch (e) {
        if (!isAbort(e)) send({ err: e instanceof LlmError ? { message: e.message, status: e.status, retryable: e.retryable, llm: true } : { message: errText(e), retryable: true, llm: false } });
      } finally {
        clearInterval(beat);
        await writing.catch(() => undefined);
        await writer.close().catch(() => undefined);
      }
    })();
    this.ctx.waitUntil(work);
    return new Response(readable, { headers: { "content-type": "application/x-ndjson" } });
  }
}

/** A model client that makes the first calls itself and hands the rest to helpers. */
export function pooledLlm(env: Env, direct: Llm): Llm {
  const ns = env.CALLER;
  if (!ns) return direct;
  const load = new Array<number>(HELPERS).fill(0);
  let own = 0;
  let failures = 0;
  let trippedUntil = 0;
  const open = (): boolean => Date.now() >= trippedUntil;

  // Takes the request already written out, and nothing else of it: once it has left, the run holds no copy.
  const viaHelper = async (body: string, signal: AbortSignal | undefined, onDelta: LlmRequest["onDelta"], onSent: LlmRequest["onSent"]): Promise<LlmResponse> => {
    const req = { signal, onDelta };
    let wireBody: string | undefined = body;
    let slot = 0;
    for (let i = 1; i < HELPERS; i++) if (load[i] < load[slot]) slot = i;
    load[slot]++;
    let settled = false;
    const infra = (why: string): LlmError => {
      if (++failures >= TRIP_AFTER) {
        failures = 0;
        trippedUntil = Date.now() + TRIP_MS;
      }
      return new LlmError(`A helper could not carry this model call: ${why}`, { retryable: true });
    };
    try {
      let res: Response;
      try {
        res = await ns.get(ns.idFromName(`caller-${slot}`)).fetch(`${INTERNAL}/call`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-scholium-key": await internalKey(env.SCHOLIUM_SECRET) },
          body: wireBody,
          signal: req.signal,
        });
        wireBody = undefined;
      } catch (e) {
        if (isAbort(e) || req.signal?.aborted) throw abortError();
        throw infra(errText(e));
      }
      if (!res.ok || !res.body) throw infra(`it answered ${res.status}`);
      onSent?.(true);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = JSON.parse(buf.slice(0, nl)) as Line;
            buf = buf.slice(nl + 1);
            if ("d" in line) req.onDelta?.(line.d[0], line.d[1]);
            else if ("ok" in line) {
              settled = true;
              failures = 0;
              return line.ok;
            } else if ("err" in line) {
              settled = true;
              if (line.err.llm) {
                failures = 0;
                throw new LlmError(line.err.message, { status: line.err.status, retryable: line.err.retryable });
              }
              throw infra(line.err.message);
            }
          }
        }
      } catch (e) {
        if (settled) throw e;
        if (isAbort(e) || req.signal?.aborted) throw abortError();
        throw infra(errText(e));
      } finally {
        void reader.cancel().catch(() => undefined);
      }
      if (req.signal?.aborted) throw abortError();
      throw infra("it stopped before the model finished");
    } finally {
      load[slot]--;
    }
  };

  return {
    get maxParallel() {
      return open() ? POOLED_CALLS : DIRECT_CALLS;
    },
    call(req) {
      // A call that carries files stays here: the files are read from this run's own storage.
      const files = req.messages.some((m) => m.role === "user" && m.attachments?.length);
      if (own < DIRECT_CALLS || files || !open()) {
        own++;
        const p = direct.call(req).finally(() => {
          own--;
        });
        req.onSent?.(false);
        return p;
      }
      const wire: Wire = { model: req.model, system: req.system, messages: req.messages, tools: req.tools, maxOutput: req.maxOutput, purpose: req.purpose };
      return viaHelper(JSON.stringify(wire), req.signal, req.onDelta, req.onSent);
    },
    relay: (executor, system, command, signal) => direct.relay(executor, system, command, signal),
  };
}

function abortError(): Error {
  const e = new Error("The call was interrupted.");
  e.name = "AbortError";
  return e;
}
