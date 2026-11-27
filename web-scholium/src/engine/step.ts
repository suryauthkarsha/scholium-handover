// One step of one task: at most one model call, then the tool calls the model asked for.
// A task is a sequence of such steps; everything a step needs is in the stored transcript and the ledger,
// so a step can be repeated after a restart without losing or inventing work.
import { MODELS, ZERO_USAGE, costOf } from "../shared/models";
import type { Agent, Attachment, Msg, Note, Task, ToolCall, ToolResult } from "../shared/types";
import { LEAD_TASKS, TERMINAL, maxRounds } from "./consts";
import type { Engine } from "./engine";
import { buildPack } from "./pack";
import { COMPACT_REQUEST, NUDGE_BUDGET, NUDGE_NO_TOOL, NUDGE_TRUNCATED, NUDGE_TURNS, ROLE_OF, assignmentBrief, phaseBrief, systemPrompt } from "./prompts";
import { LlmError, isAbort, type AttachmentData, type LlmResponse } from "./providers";
import { SAVE_PROGRESS, SUBMIT_OF, TOOL_NAMES, ToolError, toolsFor, type ToolOutcome } from "./tools";
import { b64encode, clip, errText, estTokens, fmtDuration, oneLine } from "./util";

const INTERRUPTED = "This call was interrupted by a platform restart and may or may not have taken effect. Check the ledger (search_workspace, read_item) before repeating it.";
const OVERFLOW = /context|too long|too large|too many tokens|maximum.{0,40}tokens|exceeds? the|token limit|prompt is too/i;
const MAX_RESULT_CHARS = 60000;

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const roundOf = (t: Task): number => n(t.input.round);

function transcriptChars(msgs: Msg[]): number {
  let c = 0;
  for (const m of msgs) {
    if (m.role === "user") c += m.text.length + (m.attachments?.length ?? 0) * 4000;
    else if (m.role === "assistant") {
      c += m.text.length + (m.thinking?.length ?? 0);
      for (const call of m.calls) c += call.name.length + JSON.stringify(call.args ?? {}).length + (call.badJson?.length ?? 0);
    } else for (const r of m.results) c += r.output.length + 40;
  }
  return c;
}

function loadAttachment(eng: Engine, a: Attachment): AttachmentData | null {
  const bytes = eng.uploadBytes(a.uploadId);
  if (!bytes) return null;
  return { kind: a.kind, mime: a.mime, name: a.name, base64: b64encode(bytes) };
}

/** Sends the model's partial output to the viewers, a few times a second at most. */
function deltaSink(eng: Engine, task: Task, agent: Agent): { push: (kind: "text" | "thinking", text: string) => void; end: () => void } {
  const buf = { text: "", thinking: "" };
  let last = 0;
  const send = (kind: "text" | "thinking"): void => {
    if (!buf[kind]) return;
    const text = buf[kind];
    buf[kind] = "";
    try {
      eng.hooks.broadcast({ t: "delta", taskId: task.id, agentId: agent.id, kind, text });
    } catch {
      // A viewer that went away must never disturb the run.
    }
  };
  return {
    push(kind, text) {
      buf[kind] += text;
      const now = Date.now();
      if (now - last < 300) return;
      last = now;
      send("thinking");
      send("text");
    },
    end() {
      send("thinking");
      send("text");
    },
  };
}

// ---------- subagent results ----------
function subagentSection(eng: Engine, id: string, includePending: boolean): string {
  const a = eng.m.agent.get(id);
  if (!a) return `### ${id}\nThis subagent no longer exists.`;
  const head = `### ${a.id} — ${a.name} (${MODELS[a.model].label})`;
  const q = `Question: ${oneLine(a.assignment?.question ?? "", 500)}`;
  if (!eng.awaitReady(a)) {
    if (!includePending) return "";
    return `${head} — ${a.status === "completed" ? "finished, review by another model still pending" : a.status}\n${q}\nNot included yet. Call await_subagents again to receive it.`;
  }
  const recordedClaims = eng
    .all("claim")
    .filter((c) => c.authorId === a.id)
    .map((c) => c.id);
  const recordedExps = eng
    .all("experiment")
    .filter((x) => x.byAgent === a.id)
    .map((x) => x.id);
  if (a.status !== "completed" || !a.result) {
    const kept = [recordedClaims.length ? `claims ${recordedClaims.join(", ")}` : "", recordedExps.length ? `experiments ${recordedExps.join(", ")}` : ""].filter(Boolean).join("; ");
    return `${head} — ${a.status.toUpperCase()}\n${q}\nReason: ${oneLine(a.error ?? "no reason recorded", 600)}\nNo result was returned.${kept ? ` What it recorded before stopping is in the ledger and has not been reviewed: ${kept}.` : " It recorded nothing in the ledger."}`;
  }
  const r = a.result;
  const lines = [`${head} — completed`, q, `Answer:\n${clip(r.answer, 6000)}`];
  if (r.findings.length) lines.push(`Findings:\n${r.findings.map((f) => `- ${oneLine(f, 500)}`).join("\n")}`);
  if (r.claimIds.length) {
    lines.push(
      `Claims: ${r.claimIds
        .map((cid) => {
          const c = eng.m.claim.get(cid);
          return c ? `${cid} [${c.label}${c.status !== "active" ? `, ${c.status}` : ""}]` : cid;
        })
        .join(", ")}`,
    );
  }
  if (r.experimentIds.length) {
    lines.push(
      `Experiments: ${r.experimentIds
        .map((xid) => {
          const x = eng.m.experiment.get(xid);
          return x ? `${xid} (${x.status}${x.verified.command && x.verified.transcript ? ", integrity checks passed" : ", not usable as evidence"})` : xid;
        })
        .join(", ")}`,
    );
  }
  if (r.unresolved.length) lines.push(`Unresolved, by its own account:\n${r.unresolved.map((f) => `- ${oneLine(f, 400)}`).join("\n")}`);
  lines.push(`Stated confidence: ${oneLine(r.confidence, 500)}`);
  if (a.review) {
    const by = eng.m.agent.get(a.review.byAgent);
    lines.push(
      `Review by ${by?.name ?? a.review.byAgent} (${MODELS[a.review.byModel].label}): ${a.review.verdict.replace(/_/g, " ").toUpperCase()}${
        a.review.issues.length ? `\nIssues the reviewer found:\n${a.review.issues.map((i) => `- ${oneLine(i, 500)}`).join("\n")}` : ""
      }`,
    );
  } else {
    lines.push(`Review: ${a.reviewNote ?? "none"}`);
  }
  return lines.join("\n");
}

function subagentReport(eng: Engine, ids: string[], early: boolean): string {
  const parts = ids.map((id) => subagentSection(eng, id, true)).filter(Boolean);
  const head = early
    ? "The wait was interrupted because the user sent an instruction (it follows this message). Results that are ready are below; the others are still at work."
    : "Results of the subagents you waited for. A reviewer's verdict is another model's opinion, not proof: check what you build on.";
  return clip(`${head}\n\n${parts.join("\n\n")}`, MAX_RESULT_CHARS);
}

// ---------- opening message ----------
function outstandingChildren(eng: Engine, task: Task, agent: Agent): string {
  if (task.type === "subagent_review") return "";
  const reported = new Set(strs(task.input.reported));
  const kids = eng.all("agent").filter((a) => a.parentId === agent.id && a.status !== "cancelled" && !reported.has(a.id));
  if (!kids.length) return "";
  const shown = kids.slice(0, 30);
  return `## Subagents of yours whose results you have not collected\n${shown
    .map((a) => `- ${a.id} (${a.status === "completed" ? (eng.awaitReady(a) ? "finished and reviewed" : "finished, under review") : a.status}): ${oneLine(a.assignment?.question ?? "", 220)}`)
    .join("\n")}${kids.length > shown.length ? `\n- … and ${kids.length - shown.length} more` : ""}\nCollect them with await_subagents, or stop the ones you no longer need with cancel_subagents.`;
}

function brief(eng: Engine, task: Task, agent: Agent): string {
  const submit = SUBMIT_OF[task.type];
  if (task.type === "subagent") {
    const parent = eng.m.agent.get(agent.parentId ?? "");
    if (!agent.assignment) return `Finish with ${submit}.`;
    return assignmentBrief(agent.assignment, { parentName: parent?.name ?? "your lead", submitTool: submit, canDelegate: eng.canDelegate(agent), depth: agent.depth });
  }
  const mode = eng.mode();
  return phaseBrief(task.type, {
    mode,
    cycle: task.cycle,
    submitTool: submit,
    canDelegate: task.type !== "subagent_review" && eng.canDelegate(agent),
    committed: eng.run.approachCommitted[agent.id] === task.cycle,
    focus: task.cycle > 1 ? eng.run.focus : undefined,
    round: maxRounds(mode) > 1 ? roundOf(task) + 1 : undefined,
  });
}

function openingMsg(eng: Engine, task: Task, agent: Agent, handoff?: string): Msg {
  if (LEAD_TASKS.has(task.type)) for (const i of eng.pendingInstructions(agent)) eng.markDelivered(i, agent, task);
  const parts = [buildPack(eng, task, agent)];
  if (handoff) {
    parts.push(
      `## Your handoff to yourself\nYour context was rebuilt from the ledger. Before that happened, this is what was saved about where you were. Trust the ledger above over this note where they differ.\n\n${clip(handoff, 40000)}`,
    );
  }
  parts.push(outstandingChildren(eng, task, agent));
  parts.push(brief(eng, task, agent));
  task.uploadsSeen = eng.m.upload.size;
  return { role: "user", text: parts.filter(Boolean).join("\n\n"), origin: "pack" };
}

// ---------- finishing ----------
function closeTask(eng: Engine, task: Task, agent: Agent, result: Record<string, unknown>): void {
  const now = eng.now();
  task.status = "done";
  task.result = result;
  task.endedAt = now;
  task.waiting = undefined;
  task.error = undefined;
  eng.put("task", task);
  if (task.type === "subagent") {
    agent.status = "completed";
    agent.endedAt = now;
    agent.error = undefined;
    eng.put("agent", agent);
    eng.recount();
    eng.event("success", "subagent", `${agent.name} finished its assignment${result.forced ? " (closed by the platform)" : ""}.`, agent.id, task.id);
    eng.scheduleReview(agent);
  } else {
    if (LEAD_TASKS.has(task.type)) {
      if (eng.run.counters[`fail_${agent.id}`]) {
        eng.run.counters[`fail_${agent.id}`] = 0;
        eng.touch();
      }
      if (!result.forced) eng.event("info", "task", `${agent.name} finished: ${task.title}.`, agent.id, task.id);
    }
    eng.refreshLead(agent.id);
  }
  eng.release_transcript(task.id);
}

function failSubagent(eng: Engine, task: Task, agent: Agent, reason: string): void {
  const now = eng.now();
  task.status = "failed";
  task.error = clip(reason, 800);
  task.endedAt = now;
  task.waiting = undefined;
  eng.put("task", task);
  agent.status = "failed";
  agent.error = clip(reason, 800);
  agent.endedAt = now;
  eng.put("agent", agent);
  for (const child of eng.all("agent")) if (child.parentId === agent.id) eng.cancelAgent(child.id, `Its parent ${agent.id} failed.`);
  eng.recount();
  eng.event("error", "subagent", `${agent.name} failed: ${oneLine(reason, 400)}`, agent.id, task.id);
  eng.release_transcript(task.id);
}

/** Closes a task the model would not or could not close itself. Nothing is invented: the record says the platform did it. */
function forceFinish(eng: Engine, task: Task, agent: Agent, why: string): void {
  if (task.type === "subagent") {
    const claims = eng.all("claim").filter((c) => c.authorId === agent.id && c.status === "active");
    const exps = eng.all("experiment").filter((x) => x.byAgent === agent.id);
    if (!claims.length && !exps.length) {
      failSubagent(eng, task, agent, `${why} It submitted no result and recorded nothing in the ledger.`);
      return;
    }
    agent.result = {
      answer: `[Written by the platform, not by the model] ${agent.name} did not submit a result: ${why} The items it recorded in the ledger are listed below. No summary or conclusion was produced; read the items themselves.`,
      findings: [...claims.map((c) => `${c.id} (${c.label}): ${oneLine(c.statement, 300)}`), ...exps.map((x) => `${x.id} (${x.status}): ${oneLine(x.purpose, 200)}`)].slice(0, 40),
      claimIds: claims.map((c) => c.id),
      experimentIds: exps.map((x) => x.id),
      unresolved: ["The assignment's question was not answered by the subagent itself."],
      confidence: "Not stated: this result was assembled by the platform from the ledger.",
    };
    eng.put("agent", agent);
    eng.event("warn", "subagent", `${agent.name} was closed by the platform: ${oneLine(why, 300)}`, agent.id, task.id);
    closeTask(eng, task, agent, { forced: true });
    return;
  }
  if (task.type === "subagent_review") {
    const subject = eng.m.agent.get(task.subjectAgentId ?? "");
    if (subject && !subject.review) {
      subject.reviewNote = `The reviewer (${agent.name}) did not reach a verdict: ${why} Treat this result as unreviewed.`;
      eng.put("agent", subject);
    }
    eng.event("warn", "subagent_review", `${agent.name} did not complete its review of ${task.subjectAgentId ?? "a subagent"}: ${oneLine(why, 300)}`, agent.id, task.id);
    closeTask(eng, task, agent, { forced: true });
    return;
  }
  const note: Note = {
    id: eng.id("N"),
    kind: "system",
    text: `The platform closed "${task.title}" without a submission from ${agent.name}: ${why} What ${agent.name} recorded in the ledger during this task stands as recorded; no summary was written.`,
    byAgent: agent.id,
    team: agent.team,
    cycle: task.cycle,
    phase: task.phase,
    createdAt: eng.now(),
  };
  eng.put("note", note);
  eng.index(note.id, "note", `system by ${agent.name}`, note.text);
  eng.event("warn", "task", `${agent.name} did not close "${task.title}"; the platform closed it: ${oneLine(why, 300)}`, agent.id, task.id);
  closeTask(eng, task, agent, task.type === "decide" ? { forced: true, status: "progress", nextFocus: "" } : { forced: true });
}

// ---------- context rebuild ----------
function deterministicHandoff(msgs: Msg[]): string {
  const outputs = new Map<string, ToolResult>();
  for (const m of msgs) if (m.role === "tool") for (const r of m.results) outputs.set(r.callId, r);
  const calls: string[] = [];
  let lastText = "";
  for (let i = msgs.length - 1; i >= 0 && calls.length < 25; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    if (!lastText && m.text.trim()) lastText = m.text.trim();
    for (let j = m.calls.length - 1; j >= 0 && calls.length < 25; j--) {
      const c = m.calls[j];
      const r = outputs.get(c.id);
      calls.push(`- ${c.name}(${oneLine(JSON.stringify(c.args ?? {}), 260)}) → ${r ? `${r.isError ? "ERROR: " : ""}${oneLine(r.output, 320)}` : "no result recorded"}`);
    }
  }
  return [
    "(The platform wrote this handoff from your transcript because no handoff could be obtained from you. It lists actions, not conclusions.)",
    calls.length ? `Your most recent tool calls, oldest first:\n${calls.reverse().join("\n")}` : "No tool calls were made in this task before the rebuild.",
    lastText ? `The last thing you wrote:\n${clip(lastText, 3000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function rebuild(eng: Engine, task: Task, agent: Agent, handoff: string, how: string): void {
  const first = openingMsg(eng, task, agent, handoff);
  eng.replaceMsgs(task, [first]);
  task.compactions++;
  task.input.ctxTokens = estTokens(first.role === "user" ? first.text.length : 0);
  delete task.input.turnNudged;
  delete task.input.budgetNudged;
  eng.put("task", task);
  eng.event("info", "compaction", `${agent.name}'s context was rebuilt from the ledger (${how}). Open obligations and objections are carried in the new briefing.`, agent.id, task.id);
}

async function compact(eng: Engine, task: Task, agent: Agent, signal: AbortSignal): Promise<void> {
  const msgs = eng.msgs(task.id);
  const purpose = `compact|${task.id}|${agent.id}`;
  const method = eng.method;
  const maxOutput = Math.min(16000, task.maxOutput);
  const started = eng.now();
  let handoff = "";
  let how = "handoff written by the model";
  try {
    const res = await eng.services.llm.call({
      model: task.model,
      system: systemPrompt(ROLE_OF[task.type], agent.name, agent.model) + (method.byRole[ROLE_OF[task.type]] ?? ""),
      messages: [...msgs, { role: "user", text: COMPACT_REQUEST, origin: "system" }],
      tools: [SAVE_PROGRESS.def],
      maxOutput,
      purpose,
      signal,
      loadAttachment: (a) => loadAttachment(eng, a),
    });
    const cost = costOf(task.model, res.usage);
    eng.charge(task, agent, task.model, res.usage, cost);
    eng.recordCall({ promptVersion: method.version, taskId: task.id, agentId: agent.id, model: task.model, providerModel: res.providerModel, purpose, requested: res.requested, reported: res.reported, usage: res.usage, costUsd: cost, ms: res.ms, status: "ok", stop: res.stop, turn: task.turns, attempt: task.attempts + 1 });
    noteMismatch(eng, task, agent, res);
    const call = res.calls.find((c) => c.name === "save_progress");
    const arg = call?.args?.handoff;
    handoff = typeof arg === "string" && arg.trim() ? arg : res.text;
  } catch (e) {
    if (isAbort(e)) throw e;
    const status = e instanceof LlmError ? e.status : undefined;
    eng.recordCall({ promptVersion: method.version, taskId: task.id, agentId: agent.id, model: task.model, purpose, requested: { effort: MODELS[task.model].effort, maxOutput }, reported: {}, usage: { ...ZERO_USAGE }, costUsd: 0, ms: Math.max(0, eng.now() - started), status: "error", httpStatus: status, error: clip(errText(e), 1200), turn: task.turns, attempt: task.attempts + 1 });
    const overflow = (status === 400 || status === 413) && OVERFLOW.test(errText(e));
    if (e instanceof LlmError && e.retryable && !overflow && task.attempts < 2) throw e;
    how = `handoff written by the platform, because the model call for it failed: ${oneLine(errText(e), 200)}`;
  }
  if (TERMINAL.has(task.status)) return;
  if (!handoff.trim()) {
    handoff = deterministicHandoff(msgs);
    if (how.startsWith("handoff written by the model")) how = "handoff written by the platform, because the model returned none";
  }
  task.attempts = 0;
  rebuild(eng, task, agent, handoff, how);
}

function noteMismatch(eng: Engine, task: Task, agent: Agent, res: LlmResponse): void {
  if (!res.reported.mismatch) return;
  const key = `mismatch_${task.model}`;
  const seen = eng.run.counters[key] ?? 0;
  eng.run.counters[key] = seen + 1;
  eng.touch();
  if (seen) return;
  eng.event(
    "error",
    "model",
    `Model check failed for ${MODELS[task.model].label}: the provider reported "${res.providerModel ?? "no model name"}" (${res.reported.mismatch}) for a call that requested ${MODELS[task.model].id}. The call is recorded with this mismatch; nothing was substituted by Scholium.`,
    agent.id,
    task.id,
  );
}

// ---------- the step ----------
function markStarted(eng: Engine, task: Task, agent: Agent): void {
  const now = eng.now();
  if (task.status === "queued") {
    task.status = "running";
    task.startedAt ??= now;
    task.notBefore = undefined;
    eng.put("task", task);
  }
  if (agent.kind === "subagent") {
    if (agent.status !== "running") {
      agent.status = "running";
      agent.startedAt ??= now;
      eng.put("agent", agent);
      eng.recount();
    }
  } else {
    eng.refreshLead(agent.id);
  }
}

function describe(calls: ToolCall[], text: string): string {
  if (!calls.length) return oneLine(text, 140) || "Thinking";
  const names = calls.map((c) => c.name.replace(/_/g, " "));
  return clip(names.join(" · "), 140);
}

async function step(eng: Engine, task: Task, signal: AbortSignal): Promise<void> {
  if (TERMINAL.has(task.status)) return;
  const agent = eng.m.agent.get(task.agentId);
  if (!agent) {
    eng.cancelTask(task, "The agent this task belonged to no longer exists.");
    return;
  }
  markStarted(eng, task, agent);
  const submit = SUBMIT_OF[task.type];
  const sys = (text: string): Msg => ({ role: "user", text, origin: "system" });
  let msgs = eng.msgs(task.id);

  if (!msgs.length) {
    eng.appendMsgs(task, openingMsg(eng, task, agent));
  } else {
    // Repair a transcript that a restart cut in the middle of a turn.
    const last = msgs[msgs.length - 1];
    if (last.role === "assistant") {
      if (last.calls.length) eng.appendMsgs(task, { role: "tool", results: last.calls.map((c) => ({ callId: c.id, name: c.name, output: INTERRUPTED, isError: true })) });
      else eng.appendMsgs(task, sys(NUDGE_NO_TOOL(submit)));
    }
    if (LEAD_TASKS.has(task.type)) {
      for (const i of eng.pendingInstructions(agent)) {
        eng.markDelivered(i, agent, task);
        eng.appendMsgs(task, { role: "user", text: `[User instruction ${i.id}${i.target === "all" ? "" : ", addressed to you alone"}] ${i.text}`, origin: "user" });
      }
    }
    const total = eng.m.upload.size;
    if (total > task.uploadsSeen) {
      if (LEAD_TASKS.has(task.type)) {
        const fresh = eng
          .all("upload")
          .sort((a, b) => a.addedAt - b.addedAt)
          .slice(task.uploadsSeen);
        eng.appendMsgs(
          task,
          sys(
            `[Platform] The user added ${fresh.length === 1 ? "a file" : `${fresh.length} files`} to the run:\n${fresh
              .map((u) => `- ${u.id} "${u.name}" (${u.kind}${u.pages ? `, ${u.pages} pages` : ""})${u.sourceId ? ` — extracted text is ${u.sourceId} (read_item)` : " — no text could be extracted"}${u.kind === "image" || u.kind === "pdf" ? "; view the original with view_upload" : ""}`)
              .join("\n")}\nTake them into account if they bear on your work.`,
          ),
        );
      }
      task.uploadsSeen = total;
      eng.put("task", task);
    }
    msgs = eng.msgs(task.id);
    const ctx = Math.max(estTokens(transcriptChars(msgs)), n(task.input.ctxTokens));
    if (ctx > eng.opts.compactAtTokens && msgs.length > 2) {
      await compact(eng, task, agent, signal);
      return;
    }
    if (agent.kind === "subagent" && agent.assignment && agent.costUsd >= agent.assignment.budgetUsd && !task.input.budgetNudged) {
      task.input.budgetNudged = true;
      task.maxTurns = Math.min(task.maxTurns, task.turns + 2);
      eng.appendMsgs(task, sys(NUDGE_BUDGET(submit)));
    }
    const left = task.maxTurns - task.turns;
    if (left <= 0) {
      forceFinish(eng, task, agent, agent.kind === "subagent" && task.input.budgetNudged ? "its allowance for this assignment was used up." : `it used all ${task.maxTurns} turns allowed for this task.`);
      return;
    }
    if (left <= 2 && !task.input.turnNudged) {
      task.input.turnNudged = true;
      eng.appendMsgs(task, sys(NUDGE_TURNS(left, submit)));
    }
  }

  // ---- the model call ----
  const purpose = `${task.type}|${task.id}|${agent.id}`;
  const method = eng.method;
  const turn = task.turns + 1;
  const attempt = task.attempts + 1;
  const started = eng.now();
  const delta = deltaSink(eng, task, agent);
  let res: LlmResponse;
  eng.thinking.add(task.id);
  try {
    res = await eng.services.llm.call({
      model: task.model,
      system: systemPrompt(ROLE_OF[task.type], agent.name, agent.model) + (method.byRole[ROLE_OF[task.type]] ?? ""),
      messages: eng.msgs(task.id),
      tools: toolsFor(eng, task, agent).map((t) => t.def),
      maxOutput: task.maxOutput,
      purpose,
      signal,
      onDelta: delta.push,
      loadAttachment: (a) => loadAttachment(eng, a),
    });
  } catch (e) {
    eng.thinking.delete(task.id);
    delta.end();
    if (!isAbort(e)) {
      eng.recordCall({ promptVersion: method.version, taskId: task.id, agentId: agent.id, model: task.model, purpose, requested: { effort: MODELS[task.model].effort, maxOutput: task.maxOutput }, reported: {}, usage: { ...ZERO_USAGE }, costUsd: 0, ms: Math.max(0, eng.now() - started), status: "error", httpStatus: e instanceof LlmError ? e.status : undefined, error: clip(errText(e), 1200), turn, attempt });
    }
    throw e;
  }
  eng.thinking.delete(task.id);
  delta.end();
  const cost = costOf(task.model, res.usage);
  eng.charge(task, agent, task.model, res.usage, cost);
  const callRef = eng.recordCall({ promptVersion: method.version, taskId: task.id, agentId: agent.id, model: task.model, providerModel: res.providerModel, purpose, requested: res.requested, reported: res.reported, usage: res.usage, costUsd: cost, ms: res.ms, status: "ok", stop: res.stop, turn, attempt });
  noteMismatch(eng, task, agent, res);
  task.turns++;
  agent.turns++;
  task.attempts = 0;
  task.error = undefined;
  task.input.ctxTokens = res.usage.input + res.usage.cacheRead + res.usage.cacheWrite + res.usage.output;
  agent.lastActivity = describe(res.calls, res.text);
  eng.put("task", task);
  eng.put("agent", agent);
  if (TERMINAL.has(task.status)) return;

  const thinking = res.thinking ? clip(res.thinking, 12000) : undefined;

  // ---- no tool call: nothing happened in the world ----
  if (!res.calls.length) {
    const add: Msg[] = [];
    if (res.text.trim()) add.push({ role: "assistant", text: res.text, thinking, calls: [], raw: res.raw, callRef });
    if (res.truncated) {
      const cut = n(task.input.truncations) + 1;
      task.input.truncations = cut;
      if (cut > 2) {
        if (add.length) eng.appendMsgs(task, ...add);
        forceFinish(eng, task, agent, "its output was cut off at the output limit three times in a row without a usable tool call.");
        return;
      }
      add.push(sys(NUDGE_TRUNCATED(res.dropped)));
    } else {
      task.nudges++;
      if (task.nudges > 3) {
        if (add.length) eng.appendMsgs(task, ...add);
        forceFinish(eng, task, agent, "it stopped calling tools and did not submit, after three reminders.");
        return;
      }
      add.push(sys(NUDGE_NO_TOOL(submit)));
    }
    eng.appendMsgs(task, ...add);
    return;
  }

  // ---- tool calls, in order ----
  eng.appendMsgs(task, { role: "assistant", text: res.text, thinking, calls: res.calls, raw: res.raw, callRef });
  const results: ToolResult[] = [];
  const attachments: Attachment[] = [];
  let finish: Record<string, unknown> | undefined;
  let wait: { callId: string; ids: string[] } | undefined;
  for (const call of res.calls) {
    if (finish || wait) {
      results.push({ callId: call.id, name: call.name, output: `Not executed: ${finish ? "the task was closed" : "the task was suspended"} by an earlier call in the same message.`, isError: true });
      continue;
    }
    if (call.badJson !== undefined) {
      results.push({ callId: call.id, name: call.name, output: `The arguments of ${call.name} were not valid JSON, so the call was not executed. Send it again with valid JSON. Received: ${clip(call.badJson, 300)}`, isError: true });
      continue;
    }
    const spec = toolsFor(eng, task, agent).find((t) => t.def.name === call.name);
    if (!spec) {
      const known = TOOL_NAMES.includes(call.name) || call.name === SAVE_PROGRESS.def.name;
      results.push({ callId: call.id, name: call.name, output: known ? `${call.name} is not available in this task at this point.` : `There is no tool named "${call.name}".`, isError: true });
      continue;
    }
    try {
      const out = await spec.run({ eng, task, agent, signal, callId: call.id }, call.args ?? {});
      const o: ToolOutcome = typeof out === "string" ? { output: out } : out;
      if (o.wait) {
        wait = { callId: call.id, ids: o.wait };
      } else {
        results.push({ callId: call.id, name: call.name, output: clip(o.output, MAX_RESULT_CHARS) });
        if (o.attachments?.length) attachments.push(...o.attachments);
        if (o.finish) finish = o.finish;
      }
    } catch (e) {
      if (isAbort(e) || signal.aborted) throw e;
      results.push({ callId: call.id, name: call.name, output: e instanceof ToolError ? e.message : `The tool failed with an internal error and did nothing: ${errText(e)}`, isError: true });
    }
    if (TERMINAL.has(task.status)) return;
  }
  task.nudges = 0;
  task.input.truncations = 0;

  if (wait) {
    const subs = wait.ids.map((id) => eng.m.agent.get(id));
    if (subs.every((a) => !a || eng.awaitReady(a))) {
      results.push({ callId: wait.callId, name: "await_subagents", output: subagentReport(eng, wait.ids, false) });
      task.input.reported = [...new Set([...strs(task.input.reported), ...wait.ids])];
    } else {
      task.waiting = { callId: wait.callId, agentIds: wait.ids, held: results, since: eng.now() };
      if (attachments.length) task.input.heldAttachments = attachments;
      task.status = "waiting";
      eng.put("task", task);
      agent.lastActivity = `Waiting for ${wait.ids.length} subagent${wait.ids.length === 1 ? "" : "s"}`;
      if (agent.kind === "subagent") {
        agent.status = "waiting";
        eng.put("agent", agent);
        eng.recount();
      } else {
        eng.put("agent", agent);
        eng.refreshLead(agent.id);
      }
      return;
    }
  }

  const add: Msg[] = [{ role: "tool", results }];
  if (attachments.length) add.push({ role: "user", text: `[Platform] Attached as requested: ${attachments.map((a) => `${a.uploadId} "${a.name}"`).join(", ")}.`, attachments, origin: "system" });
  if (res.dropped.length && !finish) add.push(sys(NUDGE_TRUNCATED(res.dropped)));
  eng.appendMsgs(task, ...add);
  if (finish) closeTask(eng, task, agent, finish);
}

// ---------- errors ----------
function onError(eng: Engine, task: Task, e: unknown): void {
  if (TERMINAL.has(task.status)) return;
  const agent = eng.m.agent.get(task.agentId);
  if (!agent) {
    eng.cancelTask(task, "The agent this task belonged to no longer exists.");
    return;
  }
  const requeue = (notBefore?: number): void => {
    task.status = "queued";
    task.notBefore = notBefore;
    eng.put("task", task);
    if (agent.kind === "subagent") {
      if (agent.status !== "queued") {
        agent.status = "queued";
        eng.put("agent", agent);
        eng.recount();
      }
    } else {
      eng.refreshLead(agent.id);
    }
  };
  if (isAbort(e)) {
    // Aborted without being cancelled: the step starts again from the saved transcript.
    requeue();
    return;
  }
  const message = errText(e);
  const llm = e instanceof LlmError ? e : undefined;
  if (llm && (llm.status === 400 || llm.status === 413) && OVERFLOW.test(message)) {
    const count = n(task.input.overflows) + 1;
    const msgs = eng.msgs(task.id);
    if (count <= 2 && msgs.length > 1) {
      task.input.overflows = count;
      rebuild(eng, task, agent, deterministicHandoff(msgs), `the provider refused the request as too long: ${oneLine(message, 160)}`);
      requeue();
      return;
    }
  }
  task.attempts++;
  task.error = clip(message, 800);
  const cap = llm ? (task.model === "gpt55pro" && llm.status === 524 ? 2 : eng.opts.maxAttempts) : 3;
  const retryable = llm ? llm.retryable : true;
  if (retryable && task.attempts < cap) {
    const table = eng.opts.backoffMs;
    const delay = table[Math.min(task.attempts - 1, table.length - 1)] ?? 2000;
    requeue(eng.now() + delay);
    eng.event("warn", "retry", `${agent.name}: the call to ${MODELS[task.model].label} failed — ${oneLine(message, 360)}. Retrying in ${fmtDuration(delay)} (attempt ${task.attempts + 1} of ${cap}).`, agent.id, task.id);
    return;
  }
  const reason = `${MODELS[task.model].label} returned an error${task.attempts > 1 ? ` on ${task.attempts} attempts in a row` : " that cannot be retried"}: ${message}`;
  if (task.type === "subagent") {
    failSubagent(eng, task, agent, reason);
    return;
  }
  task.status = "failed";
  task.endedAt = eng.now();
  task.waiting = undefined;
  eng.put("task", task);
  eng.refreshLead(agent.id);
  eng.release_transcript(task.id);
  if (task.type === "subagent_review") {
    eng.event("warn", "subagent_review", `${agent.name}'s review of ${task.subjectAgentId ?? "a subagent"} failed: ${oneLine(reason, 360)}`, agent.id, task.id);
    return;
  }
  const key = `fail_${agent.id}`;
  const fails = (eng.run.counters[key] ?? 0) + 1;
  eng.run.counters[key] = fails;
  eng.touch();
  eng.event("error", "task", `${agent.name} could not complete "${task.title}": ${oneLine(reason, 420)}`, agent.id, task.id);
  const peers = eng.all("task").filter((t) => t.type === task.type && t.cycle === task.cycle && roundOf(t) === roundOf(task));
  if (fails >= 2 || peers.every((t) => t.status === "failed")) {
    eng.attention(`${agent.name} could not complete "${task.title}". ${reason}`);
  }
}

/** Runs one step of a task. Never rejects: every failure ends in a retry, a recorded failure or a request for attention. */
export async function runStep(eng: Engine, task: Task): Promise<void> {
  const ac = new AbortController();
  eng.aborts.set(task.id, ac);
  try {
    await step(eng, task, ac.signal);
  } catch (e) {
    try {
      onError(eng, task, e);
    } catch (inner) {
      eng.event("error", "engine", `Internal error while handling a failed step of ${task.id}: ${errText(inner)}`);
    }
  } finally {
    if (eng.aborts.get(task.id) === ac) eng.aborts.delete(task.id);
    if (task.reservedUsd) {
      eng.release(task.reservedUsd);
      task.reservedUsd = 0;
      eng.put("task", task);
    }
    try {
      eng.flush();
    } catch (e) {
      console.error("flush failed", errText(e));
    }
  }
}

// ---------- waiting tasks ----------
/** Makes sure every finished subagent gets reviewed by a different model, or is plainly marked as unreviewed. */
function ensureReviews(eng: Engine): void {
  const bySubject = new Map<string, Task[]>();
  for (const t of eng.m.task.values()) {
    if (t.type !== "subagent_review" || !t.subjectAgentId) continue;
    const list = bySubject.get(t.subjectAgentId);
    if (list) list.push(t);
    else bySubject.set(t.subjectAgentId, [t]);
  }
  for (const a of eng.all("agent")) {
    if (a.kind !== "subagent" || a.status !== "completed" || a.review || a.reviewNote) continue;
    const reviews = bySubject.get(a.id) ?? [];
    if (reviews.some((t) => !TERMINAL.has(t.status))) continue;
    if (reviews.length >= 2) {
      const last = reviews[reviews.length - 1];
      a.reviewNote = `Two attempts to have another model review this result failed${last.error ? ` (${oneLine(last.error, 200)})` : ""}. Treat it as unreviewed.`;
      eng.put("agent", a);
      eng.event("warn", "subagent_review", `${a.name}'s result could not be reviewed by another model after two attempts; it is marked as unreviewed.`, a.id);
      continue;
    }
    eng.scheduleReview(a);
  }
}

/** Wakes tasks whose awaited subagents are finished and reviewed, and leads that the user has just instructed. */
export function resumeWaiting(eng: Engine): void {
  if (eng.run.status !== "running") return;
  ensureReviews(eng);
  for (const task of eng.all("task")) {
    if (task.status !== "waiting") continue;
    const agent = eng.m.agent.get(task.agentId);
    if (!agent) continue;
    const w = task.waiting;
    if (!w) {
      task.status = "running";
      eng.put("task", task);
      continue;
    }
    const ready = (id: string): boolean => {
      const a = eng.m.agent.get(id);
      return !a || eng.awaitReady(a);
    };
    const all = w.agentIds.every(ready);
    const early = !all && agent.kind === "lead" && LEAD_TASKS.has(task.type) && eng.pendingInstructions(agent).length > 0;
    if (!all && !early) continue;
    const add: Msg[] = [{ role: "tool", results: [...w.held, { callId: w.callId, name: "await_subagents", output: subagentReport(eng, w.agentIds, early) }] }];
    const held = task.input.heldAttachments as Attachment[] | undefined;
    if (held?.length) add.push({ role: "user", text: `[Platform] Attached as requested: ${held.map((a) => `${a.uploadId} "${a.name}"`).join(", ")}.`, attachments: held, origin: "system" });
    delete task.input.heldAttachments;
    task.input.reported = [...new Set([...strs(task.input.reported), ...w.agentIds.filter(ready)])];
    task.waiting = undefined;
    task.status = "running";
    eng.appendMsgs(task, ...add);
    if (agent.kind === "subagent") {
      agent.status = "running";
      eng.put("agent", agent);
      eng.recount();
    } else {
      eng.refreshLead(agent.id);
    }
  }
}
