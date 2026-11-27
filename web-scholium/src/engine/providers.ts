// Gateway client. Every model call in the product goes through this file and nowhere else.
import { assertAllowed, MODELS, type ModelKey, type ModelSpec, type Usage, ZERO_USAGE } from "../shared/models";
import type { Attachment, Msg, SandboxExecutor, ToolCall } from "../shared/types";
import { errText, safeJson } from "./util";

export const GATEWAY = "https://toolkit.rork.com";

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AttachmentData {
  kind: "image" | "pdf";
  mime: string;
  name: string;
  base64: string;
}

export interface LlmRequest {
  model: ModelKey;
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  maxOutput: number;
  purpose: string;
  signal?: AbortSignal;
  onDelta?: (kind: "text" | "thinking", text: string) => void;
  /** Called once the request has left. `carried` is true when a helper holds it, so the caller need not keep the messages. */
  onSent?: (carried: boolean) => void;
  loadAttachment?: (a: Attachment) => AttachmentData | null;
}

export interface LlmResponse {
  text: string;
  thinking: string;
  calls: ToolCall[];
  /** Provider output items, replayed verbatim on the next turn. */
  raw: unknown[];
  /** Names of tool calls that were cut off before their arguments were complete. */
  dropped: string[];
  usage: Usage;
  stop: string;
  truncated: boolean;
  gatewayModel: string;
  providerModel?: string;
  requested: { effort: string; maxOutput: number; thinking?: string };
  reported: Record<string, string>;
  ms: number;
}

export interface RelayResult {
  /** Commands the provider's sandbox reports having executed. */
  commands: string[];
  /** Transcript handed back through the report tool. */
  transcript?: string;
  usage: Usage;
  model: ModelKey;
  providerModel?: string;
  ms: number;
}

export interface Llm {
  /** How many calls this client can carry at once. Unset means only what one run can hold open itself. */
  readonly maxParallel?: number;
  call(req: LlmRequest): Promise<LlmResponse>;
  relay(executor: SandboxExecutor, system: string, command: string, signal?: AbortSignal): Promise<RelayResult>;
}

export class LlmError extends Error {
  status?: number;
  retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable: boolean }) {
    super(message);
    this.name = "LlmError";
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

export function isAbort(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError";
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function extractError(body: string): string {
  const j = safeJson<Rec>(body);
  if (j) {
    const e = j.error;
    if (typeof e === "string") return e;
    const m = rec(e).message ?? j.message;
    if (typeof m === "string") return m;
  }
  return body.trim().slice(0, 600) || "empty error body";
}

async function* sse(res: Response): AsyncGenerator<{ event: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (isAbort(e)) throw e;
      throw new LlmError(`The response stream was cut: ${errText(e)}`, { retryable: true });
    }
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n") };
        event = "";
        data = [];
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
  if (data.length) yield { event, data: data.join("\n") };
}

function lastAssistantIndex(msgs: Msg[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") return i;
  return -1;
}

const attachmentNote = (a: Attachment): string =>
  `[${a.kind === "pdf" ? "Document" : "Image"} ${a.uploadId} "${a.name}" was shown at this point earlier. Call view_upload again if you need to look at it.]`;

/** Our transcript -> OpenAI Responses input items. */
export function toResponsesInput(msgs: Msg[], load?: (a: Attachment) => AttachmentData | null): unknown[] {
  const out: unknown[] = [];
  const fresh = lastAssistantIndex(msgs);
  msgs.forEach((m, idx) => {
    if (m.role === "user") {
      const content: unknown[] = [{ type: "input_text", text: m.text }];
      for (const a of m.attachments ?? []) {
        const d = idx > fresh && load ? load(a) : null;
        if (!d) content.push({ type: "input_text", text: attachmentNote(a) });
        else if (d.kind === "image") content.push({ type: "input_image", image_url: `data:${d.mime};base64,${d.base64}` });
        else content.push({ type: "input_file", filename: d.name, file_data: `data:${d.mime};base64,${d.base64}` });
      }
      out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      if (m.raw.length) out.push(...m.raw);
      else if (m.text) out.push({ role: "assistant", content: [{ type: "output_text", text: m.text }] });
    } else {
      for (const r of m.results) out.push({ type: "function_call_output", call_id: r.callId, output: r.output });
    }
  });
  return out;
}

/** Our transcript -> Anthropic messages. Tool results and the user text that follows them share one user turn. */
export function toAnthropicMessages(msgs: Msg[], load?: (a: Attachment) => AttachmentData | null): { role: string; content: Rec[] }[] {
  const out: { role: string; content: Rec[] }[] = [];
  const fresh = lastAssistantIndex(msgs);
  const pushUser = (parts: Rec[]) => {
    const last = out[out.length - 1];
    if (last && last.role === "user") last.content.push(...parts);
    else out.push({ role: "user", content: parts });
  };
  msgs.forEach((m, idx) => {
    if (m.role === "user") {
      const parts: Rec[] = [{ type: "text", text: m.text }];
      for (const a of m.attachments ?? []) {
        const d = idx > fresh && load ? load(a) : null;
        if (!d) parts.push({ type: "text", text: attachmentNote(a) });
        else if (d.kind === "image") parts.push({ type: "image", source: { type: "base64", media_type: d.mime, data: d.base64 } });
        else parts.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.base64 } });
      }
      pushUser(parts);
    } else if (m.role === "assistant") {
      const content = m.raw.length ? (m.raw as Rec[]) : [{ type: "text", text: m.text || "(no text)" }];
      out.push({ role: "assistant", content: content.map((b) => ({ ...b })) });
    } else {
      pushUser(
        m.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.callId,
          content: r.output || "(empty)",
          ...(r.isError ? { is_error: true } : {}),
        })),
      );
    }
  });
  // Cache the growing prefix: mark the final block of the final message.
  const last = out[out.length - 1];
  if (last && last.role === "user" && last.content.length) {
    const i = last.content.length - 1;
    last.content[i] = { ...last.content[i], cache_control: { type: "ephemeral" } };
  }
  return out;
}

export interface GatewayConfig {
  secret: string;
  fetch?: typeof fetch;
}

export function createGateway(cfg: GatewayConfig): Llm {
  const f: typeof fetch = cfg.fetch ?? ((input, init) => fetch(input, init));

  async function post(path: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await f(GATEWAY + path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}`, ...headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (isAbort(e)) throw e;
      throw new LlmError(`Network error reaching the model gateway: ${errText(e)}`, { retryable: true });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LlmError(`HTTP ${res.status} from the model gateway: ${extractError(text)}`, {
        status: res.status,
        retryable: RETRYABLE_STATUS.has(res.status),
      });
    }
    return res;
  }

  function openAiUsage(u: Rec): Usage {
    const cached = num(rec(u.input_tokens_details).cached_tokens);
    return {
      input: Math.max(0, num(u.input_tokens) - cached),
      cacheRead: cached,
      cacheWrite: 0,
      output: num(u.output_tokens),
      reasoning: num(rec(u.output_tokens_details).reasoning_tokens),
    };
  }

  function anthropicUsage(u: Rec): Usage {
    return {
      input: num(u.input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      output: num(u.output_tokens),
      reasoning: num(rec(u.output_tokens_details).thinking_tokens) || num(u.thinking_tokens),
    };
  }

  /** Reads a Responses API reply, streamed or not, and returns the final response object. */
  async function readResponses(res: Response, onDelta?: LlmRequest["onDelta"]): Promise<Rec> {
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/event-stream")) {
      const j = safeJson<Rec>(await res.text());
      if (!j) throw new LlmError("The gateway returned a reply that is not JSON.", { retryable: true });
      if (j.error) throw new LlmError(`Provider error: ${extractError(JSON.stringify(j))}`, { retryable: false });
      return j;
    }
    let final: Rec | undefined;
    let sawThinking = false;
    for await (const ev of sse(res)) {
      if (ev.data === "[DONE]") continue;
      const j = safeJson<Rec>(ev.data);
      if (!j) continue;
      const type = str(j.type) || ev.event;
      if (type === "response.output_text.delta") onDelta?.("text", str(j.delta));
      else if (type === "response.reasoning_summary_text.delta") {
        sawThinking = true;
        onDelta?.("thinking", str(j.delta));
      } else if (type === "response.reasoning_summary_part.added") {
        if (sawThinking) onDelta?.("thinking", "\n\n");
      } else if (type === "response.completed" || type === "response.incomplete") final = rec(j.response);
      else if (type === "response.failed") {
        const e = rec(rec(j.response).error);
        throw new LlmError(`Provider reported failure: ${str(e.message) || str(e.code) || "unknown error"}`, { retryable: /server|overload|timeout|rate/i.test(JSON.stringify(e)) });
      } else if (type === "error") {
        const msg = str(j.message) || str(rec(j.error).message) || ev.data.slice(0, 400);
        throw new LlmError(`Provider stream error: ${msg}`, { retryable: /server|overload|timeout|rate|unavailable/i.test(ev.data) });
      }
    }
    if (!final) throw new LlmError("The response stream ended before the model finished.", { retryable: true });
    return final;
  }

  async function callResponses(spec: ModelSpec, req: LlmRequest): Promise<Omit<LlmResponse, "ms" | "gatewayModel" | "requested">> {
    const stream = spec.key !== "gpt55pro";
    const body = {
      model: spec.id,
      instructions: req.system,
      input: toResponsesInput(req.messages, req.loadAttachment),
      tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })),
      reasoning: { effort: spec.effort, summary: "auto" },
      include: ["reasoning.encrypted_content"],
      store: false,
      max_output_tokens: req.maxOutput,
      parallel_tool_calls: true,
      ...(stream ? { stream: true } : {}),
    };
    const res = await post("/v2/vercel/v1/responses", body, {}, req.signal);
    const final = await readResponses(res, req.onDelta);
    const raw: unknown[] = [];
    const calls: ToolCall[] = [];
    const dropped: string[] = [];
    let text = "";
    let thinking = "";
    for (const item of (Array.isArray(final.output) ? final.output : []) as Rec[]) {
      if (item.type === "reasoning") {
        raw.push(item);
        for (const s of (Array.isArray(item.summary) ? item.summary : []) as Rec[]) thinking += (thinking ? "\n\n" : "") + str(s.text);
      } else if (item.type === "message") {
        raw.push(item);
        for (const c of (Array.isArray(item.content) ? item.content : []) as Rec[]) {
          if (c.type === "output_text") text += str(c.text);
          else if (c.type === "refusal") text += `[refusal] ${str(c.refusal)}`;
        }
      } else if (item.type === "function_call") {
        const args = safeJson<Record<string, unknown>>(str(item.arguments) || "{}");
        if (args && typeof args === "object" && !Array.isArray(args)) {
          raw.push(item);
          calls.push({ id: str(item.call_id), name: str(item.name), args });
        } else dropped.push(str(item.name));
      }
    }
    const incomplete = final.status === "incomplete";
    const reasoning = rec(final.reasoning);
    const reported: Record<string, string> = {};
    if (final.model) reported.model = str(final.model);
    if (reasoning.effort) reported.effort = str(reasoning.effort);
    if (final.service_tier) reported.service_tier = str(final.service_tier);
    return {
      text,
      thinking,
      calls,
      raw,
      dropped,
      usage: openAiUsage(rec(final.usage)),
      stop: incomplete ? str(rec(final.incomplete_details).reason) || "incomplete" : calls.length ? "tool_calls" : "end",
      truncated: incomplete || dropped.length > 0,
      providerModel: str(final.model) || undefined,
      reported,
    };
  }

  interface Block {
    type: string;
    text: string;
    thinking: string;
    signature: string;
    json: string;
    id: string;
    name: string;
    data: string;
    input?: unknown;
  }

  async function readMessages(res: Response, onDelta?: LlmRequest["onDelta"]): Promise<{ blocks: Block[]; stop: string; usage: Rec; model: string }> {
    const ct = res.headers.get("content-type") ?? "";
    const blocks: Block[] = [];
    let stop = "";
    let usage: Rec = {};
    let model = "";
    const mk = (b: Rec): Block => ({
      type: str(b.type),
      text: str(b.text),
      thinking: str(b.thinking),
      signature: str(b.signature),
      json: "",
      id: str(b.id),
      name: str(b.name),
      data: str(b.data),
      input: b.input,
    });
    if (!ct.includes("text/event-stream")) {
      const j = safeJson<Rec>(await res.text());
      if (!j) throw new LlmError("The gateway returned a reply that is not JSON.", { retryable: true });
      if (j.type === "error" || j.error) throw new LlmError(`Provider error: ${extractError(JSON.stringify(j))}`, { retryable: false });
      for (const b of (Array.isArray(j.content) ? j.content : []) as Rec[]) {
        const blk = mk(b);
        if (b.input !== undefined) blk.json = JSON.stringify(b.input);
        blocks.push(blk);
      }
      return { blocks, stop: str(j.stop_reason), usage: rec(j.usage), model: str(j.model) };
    }
    let done = false;
    for await (const ev of sse(res)) {
      const j = safeJson<Rec>(ev.data);
      if (!j) continue;
      const type = str(j.type) || ev.event;
      if (type === "message_start") {
        const m = rec(j.message);
        model = str(m.model);
        usage = { ...usage, ...rec(m.usage) };
      } else if (type === "content_block_start") {
        blocks[num(j.index)] = mk(rec(j.content_block));
      } else if (type === "content_block_delta") {
        const b = blocks[num(j.index)];
        const d = rec(j.delta);
        if (!b) continue;
        if (d.type === "text_delta") {
          b.text += str(d.text);
          onDelta?.("text", str(d.text));
        } else if (d.type === "thinking_delta") {
          b.thinking += str(d.thinking);
          onDelta?.("thinking", str(d.thinking));
        } else if (d.type === "signature_delta") b.signature += str(d.signature);
        else if (d.type === "input_json_delta") b.json += str(d.partial_json);
      } else if (type === "message_delta") {
        stop = str(rec(j.delta).stop_reason) || stop;
        const u = rec(j.usage);
        for (const k of Object.keys(u)) if (u[k] !== null && u[k] !== undefined) usage[k] = u[k];
      } else if (type === "message_stop") {
        done = true;
      } else if (type === "error") {
        const e = rec(j.error);
        throw new LlmError(`Provider stream error: ${str(e.message) || str(e.type) || ev.data.slice(0, 400)}`, {
          retryable: /overloaded|api_error|rate_limit|timeout|unavailable/i.test(ev.data),
        });
      }
    }
    if (!done && !stop) throw new LlmError("The response stream ended before the model finished.", { retryable: true });
    return { blocks: blocks.filter(Boolean), stop, usage, model };
  }

  async function callMessages(spec: ModelSpec, req: LlmRequest): Promise<Omit<LlmResponse, "ms" | "gatewayModel" | "requested">> {
    const body = {
      model: spec.id,
      max_tokens: req.maxOutput,
      stream: true,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: toAnthropicMessages(req.messages, req.loadAttachment),
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      thinking: { type: "adaptive" },
      output_config: { effort: spec.effort },
    };
    const res = await post("/v2/vercel/v1/messages", body, { "anthropic-version": "2023-06-01" }, req.signal);
    const { blocks, stop, usage, model } = await readMessages(res, req.onDelta);
    const raw: unknown[] = [];
    const calls: ToolCall[] = [];
    const dropped: string[] = [];
    let text = "";
    let thinking = "";
    for (const b of blocks) {
      if (b.type === "thinking") {
        thinking += (thinking ? "\n\n" : "") + b.thinking;
        if (b.signature) raw.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
      } else if (b.type === "redacted_thinking") {
        raw.push({ type: "redacted_thinking", data: b.data });
      } else if (b.type === "text") {
        if (b.text) {
          text += b.text;
          raw.push({ type: "text", text: b.text });
        }
      } else if (b.type === "tool_use") {
        const args = b.json ? safeJson<Record<string, unknown>>(b.json) : ((b.input ?? {}) as Record<string, unknown>);
        if (args && typeof args === "object" && !Array.isArray(args)) {
          raw.push({ type: "tool_use", id: b.id, name: b.name, input: args });
          calls.push({ id: b.id, name: b.name, args });
        } else dropped.push(b.name);
      }
    }
    const reported: Record<string, string> = {};
    if (model) reported.model = model;
    if (usage.speed) reported.speed = str(usage.speed);
    if (usage.service_tier) reported.service_tier = str(usage.service_tier);
    return {
      text,
      thinking,
      calls,
      raw,
      dropped,
      usage: anthropicUsage(usage),
      stop: stop || (calls.length ? "tool_use" : "end_turn"),
      truncated: stop === "max_tokens" || dropped.length > 0,
      providerModel: model || undefined,
      reported,
    };
  }

  const REPORT_SCHEMA = { type: "object", properties: { transcript: { type: "string" } }, required: ["transcript"], additionalProperties: false };

  return {
    async call(req: LlmRequest): Promise<LlmResponse> {
      const spec = MODELS[req.model];
      if (!spec) throw new Error(`Unknown model key "${String(req.model)}".`);
      assertAllowed(spec.id);
      const t0 = Date.now();
      const r = spec.api === "responses" ? await callResponses(spec, req) : await callMessages(spec, req);
      if (r.providerModel && !r.providerModel.includes(spec.reportedMatch)) {
        r.reported.mismatch = `expected a model name containing "${spec.reportedMatch}"`;
      }
      return {
        ...r,
        gatewayModel: spec.id,
        requested: { effort: spec.effort, maxOutput: req.maxOutput, ...(spec.api === "messages" ? { thinking: "adaptive" } : {}) },
        ms: Date.now() - t0,
      };
    },

    async relay(executor: SandboxExecutor, system: string, command: string, signal?: AbortSignal): Promise<RelayResult> {
      const t0 = Date.now();
      const userText = `<command>\n${command}\n</command>`;
      if (executor === "astra-shell") {
        const spec = MODELS.astra62;
        assertAllowed(spec.id);
        const body = {
          model: spec.id,
          instructions: system,
          input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
          tools: [
            { type: "shell", environment: { type: "containerAuto" } },
            { type: "function", name: "report_execution", description: "Report the verbatim transcript.", parameters: REPORT_SCHEMA, strict: true },
          ],
          reasoning: { effort: spec.effort },
          store: false,
          max_output_tokens: 16000,
          stream: true,
        };
        const final = await readResponses(await post("/v2/vercel/v1/responses", body, {}, signal));
        const commands: string[] = [];
        let transcript: string | undefined;
        for (const o of (Array.isArray(final.output) ? final.output : []) as Rec[]) {
          if (o.type === "shell_call") {
            const c = rec(o.action).commands;
            if (Array.isArray(c)) commands.push(c.map(String).join("\n"));
          } else if (o.type === "function_call" && o.name === "report_execution") {
            transcript = str(safeJson<Rec>(str(o.arguments))?.transcript) || transcript;
          }
        }
        return { commands, transcript, usage: openAiUsage(rec(final.usage)), model: "astra62", providerModel: str(final.model) || undefined, ms: Date.now() - t0 };
      }
      const spec = MODELS.fable52;
      assertAllowed(spec.id);
      const body = {
        model: spec.id,
        max_tokens: 16000,
        stream: true,
        system,
        messages: [{ role: "user", content: userText }],
        tools: [
          { type: "code_execution_20250825", name: "code_execution" },
          { name: "report_execution", description: "Report the verbatim transcript.", input_schema: REPORT_SCHEMA },
        ],
        thinking: { type: "adaptive" },
        output_config: { effort: spec.effort },
      };
      const res = await post("/v2/vercel/v1/messages", body, { "anthropic-version": "2023-06-01", "anthropic-beta": "code-execution-2025-08-25" }, signal);
      const { blocks, usage, model } = await readMessages(res);
      const commands: string[] = [];
      let transcript: string | undefined;
      for (const b of blocks) {
        const input = rec(b.json ? safeJson<Rec>(b.json) : b.input);
        if (b.type === "server_tool_use" && typeof input.command === "string") commands.push(input.command);
        if (b.type === "tool_use" && b.name === "report_execution" && typeof input.transcript === "string") transcript = input.transcript;
      }
      return { commands, transcript, usage: anthropicUsage(usage), model: "fable52", providerModel: model || undefined, ms: Date.now() - t0 };
    },
  };
}

export { ZERO_USAGE };
