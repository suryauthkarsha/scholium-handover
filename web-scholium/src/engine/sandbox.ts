// Real code execution. Provider sandboxes run the code; the gateway hides their raw output, so each job
// prints a checksummed transcript that is handed back through a function tool and verified here.
import { addUsage, costOf, type ModelKey, type Usage, ZERO_USAGE } from "../shared/models";
import type { Experiment, SandboxExecutor } from "../shared/types";
import { isAbort, type Llm, LlmError } from "./providers";
import { errText, safeJson, sha256Hex } from "./util";

export const RELAY_SYSTEM =
  "You are a deterministic execution relay inside a research system. The user message contains one shell command between <command> and </command>. Step 1: run it with your execution tool exactly once, byte-for-byte identical to the given command (same quoting, heredocs, newlines; never fix, shorten or reformat it). Step 2: call report_execution exactly once with `transcript` set to the tool's stdout copied verbatim from the line SX-BEGIN through the line SX-END inclusive. Never paraphrase, round, or repair anything. If the tool itself fails to start, call report_execution with transcript set to the literal error text. Output nothing else.";

export const MAX_CODE_CHARS = 24000;
export const DEFAULT_TIMEOUT_S = 90;
export const MAX_TIMEOUT_S = 240;
const STDOUT_CLIP = 5000;
const STDERR_CLIP = 1500;

const WRAP_TAIL = String.raw`python3 - <<'SX_WRAP'
import hashlib, json, platform
def clip(s, n):
    return s if len(s) <= n else s[:n//2] + '\n...[' + str(len(s)-n) + ' chars omitted]...\n' + s[-n//2:]
out = open('out.txt', errors='replace').read(); err = open('err.txt', errors='replace').read(); rc = open('rc.txt').read().strip()
body = json.dumps({'exit': int(rc), 'stdout': clip(out, __OUT__), 'stderr': clip(err, __ERR__), 'python': platform.python_version(), 'stdout_chars': len(out), 'full_stdout_sha256': hashlib.sha256(out.encode()).hexdigest()}, ensure_ascii=True)
print('SX-BEGIN'); print(body); print('SX-SHA256 ' + hashlib.sha256(body.encode()).hexdigest()); print('SX-END')
SX_WRAP`
  .replace("__OUT__", String(STDOUT_CLIP))
  .replace("__ERR__", String(STDERR_CLIP));

function delimiterFor(code: string): string {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) h = Math.imul(h ^ code.charCodeAt(i), 16777619) >>> 0;
  let d = `SX_EOF_${h.toString(16).padStart(8, "0")}`;
  while (code.includes(d)) d += "x";
  return d;
}

/** Builds the exact shell command a sandbox must run for one job. */
export function wrapJob(lang: "python" | "bash", code: string, timeoutS: number, seed?: number): string {
  const limit = Math.max(5, Math.min(MAX_TIMEOUT_S, Math.round(timeoutS)));
  const d = delimiterFor(code);
  const file = lang === "python" ? "job.py" : "job.sh";
  const runner = lang === "python" ? "python3 job.py" : "bash job.sh";
  const env = `PYTHONHASHSEED=0 ${seed !== undefined ? `SCHOLIUM_SEED=${Math.trunc(seed)} ` : ""}`;
  return `mkdir -p /tmp/sx && cd /tmp/sx && cat > ${file} <<'${d}'\n${code}\n${d}\n( ${env}timeout -k 5 ${limit} ${runner} > out.txt 2> err.txt; echo $? > rc.txt )\n${WRAP_TAIL}`;
}

export interface SxBody {
  exit: number;
  stdout: string;
  stderr: string;
  python: string;
  stdout_chars: number;
  full_stdout_sha256: string;
}

/** Verifies the in-sandbox checksum of a relayed transcript. */
export async function parseTranscript(tr: string): Promise<{ ok: true; body: SxBody } | { ok: false; error: string }> {
  const a = tr.indexOf("SX-BEGIN\n");
  if (a < 0) return { ok: false, error: `no transcript frame in the sandbox reply: ${tr.slice(0, 300)}` };
  const rest = tr.slice(a + "SX-BEGIN\n".length);
  const b = rest.indexOf("\nSX-SHA256 ");
  if (b < 0) return { ok: false, error: "transcript frame has no checksum line" };
  const body = rest.slice(0, b);
  const hash = rest.slice(b + "\nSX-SHA256 ".length).split("\n")[0].trim();
  if ((await sha256Hex(body)) !== hash) return { ok: false, error: "transcript checksum mismatch (the output was altered in transit)" };
  const j = safeJson<SxBody>(body);
  if (!j || typeof j.exit !== "number" || typeof j.stdout !== "string") return { ok: false, error: "transcript body is not the expected JSON" };
  return { ok: true, body: j };
}

export interface SandboxJob {
  lang: "python" | "bash";
  code: string;
  timeoutS?: number;
  seed?: number;
  executor: SandboxExecutor;
  signal?: AbortSignal;
}

export interface SandboxOutcome {
  status: Experiment["status"];
  exit?: number;
  stdout: string;
  stderr: string;
  stdoutChars: number;
  fullStdoutSha?: string;
  runtime: string;
  verified: { command: boolean; transcript: boolean };
  usage: Usage;
  costUsd: number;
  ms: number;
  model: ModelKey;
  providerModel?: string;
  attempts: number;
  error?: string;
}

export const EXECUTOR_MODEL: Record<SandboxExecutor, ModelKey> = { "astra-shell": "astra62", "fable-bash": "fable52" };
export const EXECUTOR_NOTES: Record<SandboxExecutor, string> = {
  "astra-shell":
    "Linux container, 2 CPUs, Python 3.13 with sympy 1.14, mpmath, numpy, scipy, networkx, pandas, matplotlib, numba, scikit-learn, statsmodels; gcc/g++, node, git. No PARI/GP, GAP, Sage, Lean, gmpy2, FLINT or z3 preinstalled.",
  "fable-bash":
    "Linux container, 1 CPU, Python 3.11 with sympy 1.12, numpy, scipy, networkx; rustc, node, bc. No gcc, PARI/GP, GAP, Sage, Lean, gmpy2, FLINT or z3 preinstalled.",
};

/** Worst-case cost of one relay attempt, reserved before the job is dispatched. */
export function relayWorstCase(executor: SandboxExecutor, codeChars: number): number {
  const inTok = 10000 + Math.ceil(codeChars / 3);
  const outTok = 4000 + Math.ceil(codeChars / 3);
  return costOf(EXECUTOR_MODEL[executor], { input: inTok, cacheRead: 0, cacheWrite: 0, output: outTok, reasoning: 0 });
}

export async function runInSandbox(llm: Llm, job: SandboxJob): Promise<SandboxOutcome> {
  const model = EXECUTOR_MODEL[job.executor];
  const command = wrapJob(job.lang, job.code, job.timeoutS ?? DEFAULT_TIMEOUT_S, job.seed);
  let usage: Usage = ZERO_USAGE;
  let ms = 0;
  let lastError = "";
  let providerModel: string | undefined;
  let verified = { command: false, transcript: false };
  const base = { stdout: "", stderr: "", stdoutChars: 0, runtime: `${job.executor}`, model };
  let attempts = 0;
  for (; attempts < 3; ) {
    attempts++;
    try {
      const r = await llm.relay(job.executor, RELAY_SYSTEM, command, job.signal);
      usage = addUsage(usage, r.usage);
      ms += r.ms;
      providerModel = r.providerModel ?? providerModel;
      const commandOk = r.commands.length === 1 && r.commands[0].trim() === command.trim();
      const parsed = r.transcript ? await parseTranscript(r.transcript) : ({ ok: false, error: "the sandbox reported no transcript" } as const);
      verified = { command: commandOk, transcript: parsed.ok };
      if (commandOk && parsed.ok) {
        const b = parsed.body;
        return {
          ...base,
          status: b.exit === 0 ? "ok" : b.exit === 124 || b.exit === 137 ? "timeout" : "error",
          exit: b.exit,
          stdout: b.stdout,
          stderr: b.stderr,
          stdoutChars: b.stdout_chars,
          fullStdoutSha: b.full_stdout_sha256,
          runtime: `${job.executor} · Python ${b.python}`,
          verified,
          usage,
          costUsd: costOf(model, usage),
          ms,
          providerModel,
          attempts,
        };
      }
      lastError = !commandOk
        ? r.commands.length === 0
          ? "the sandbox did not report running any command"
          : r.commands.length > 1
            ? `the sandbox ran ${r.commands.length} commands instead of one`
            : "the command the sandbox ran differs from the submitted code"
        : parsed.ok
          ? ""
          : parsed.error;
    } catch (e) {
      if (isAbort(e)) throw e;
      lastError = errText(e);
      if (e instanceof LlmError && !e.retryable) break;
    }
  }
  return {
    ...base,
    status: "infra_error",
    verified,
    usage,
    costUsd: costOf(model, usage),
    ms,
    providerModel,
    attempts,
    error: `Execution could not be verified after ${attempts} attempt${attempts > 1 ? "s" : ""}: ${lastError}`,
  };
}
