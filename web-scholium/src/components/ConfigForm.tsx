// The settings of a run, shared by the setup screen and the mid-run settings panel. The server validates all of
// it again: unknown models are dropped and numbers are clamped there, whatever this form sends.
import { Check } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import { modelColor, usd } from "@/components/bits";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { MODELS, MODEL_KEYS, type ModelKey } from "@/shared/models";
import { DEPTH_HARD_CAP, SPEED_CONCURRENCY, SUBAGENT_HARD_CAP, type Mode, type PublicSettings, type RunConfig, type RunTools, type SandboxExecutor, type Speed } from "@/shared/types";

export interface FormProps {
  config: RunConfig;
  onChange: (next: RunConfig) => void;
  disabled?: boolean;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="eyebrow mb-1.5">{label}</p>
      {children}
      {hint && <p className="mt-1.5 text-[0.82rem] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Choice<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { value: T; label: string; note?: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(11.5rem, 1fr))" }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`press rounded-sm border px-3 py-2.5 text-left transition-colors disabled:opacity-60 ${on ? "border-foreground/70 bg-card shadow-sm" : "border-border hover:border-foreground/35"}`}
          >
            <span className="flex items-center gap-2 text-[0.95rem] font-medium">
              <span className={`h-2 w-2 shrink-0 rounded-full border ${on ? "border-rubric bg-rubric" : "border-foreground/40"}`} />
              {o.label}
            </span>
            {o.note && <span className="mt-1 block text-[0.8rem] leading-snug text-muted-foreground">{o.note}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function ModelPicker({ label, value, onChange, min = 1, disabled }: { label: string; value: ModelKey[]; onChange: (v: ModelKey[]) => void; min?: number; disabled?: boolean }) {
  const toggle = (k: ModelKey): void => {
    const has = value.includes(k);
    if (has && value.length <= min) return;
    onChange(has ? value.filter((v) => v !== k) : [...value, k]);
  };
  return (
    <div role="group" aria-label={label} className="grid gap-2 sm:grid-cols-2">
      {MODEL_KEYS.map((k) => {
        const m = MODELS[k];
        const on = value.includes(k);
        const color = modelColor(k);
        return (
          <button
            key={k}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => toggle(k)}
            className={`press rounded-sm border px-3 py-2.5 text-left transition-colors disabled:opacity-60 ${on ? "border-foreground/70 bg-card shadow-sm" : "border-border hover:border-foreground/35"}`}
          >
            <span className="flex items-center gap-2">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border" style={on ? { background: color, borderColor: color } : { borderColor: color }}>
                {on && <Check className="h-3 w-3 text-background" strokeWidth={3} />}
              </span>
              <span className="min-w-0 truncate font-medium">{m.label}</span>
              <span className="ml-auto shrink-0 font-mono text-[0.66rem] uppercase tracking-wide text-muted-foreground">effort {m.effort}</span>
            </span>
            <span className="mt-1 block truncate font-mono text-[0.72rem] text-muted-foreground">{m.id}</span>
            {m.caveat && <span className="mt-1 block text-[0.78rem] leading-snug text-warn">{m.caveat}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function NumberBox({ label, value, onChange, min, max, unit, hint, disabled }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; unit?: string; hint?: ReactNode; disabled?: boolean }) {
  const [raw, setRaw] = useState(String(value));
  useEffect(() => setRaw(String(value)), [value]);
  const clamp = (n: number): number => Math.max(min, Math.min(max, n));
  return (
    <div className="min-w-0">
      <p className="eyebrow mb-1.5">{label}</p>
      <div className="flex items-center gap-2">
        <Input
          aria-label={label}
          inputMode="decimal"
          value={raw}
          disabled={disabled}
          className="tabular"
          onChange={(e) => {
            setRaw(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value.trim() && Number.isFinite(n) && n >= min && n <= max) onChange(n);
          }}
          onBlur={() => {
            const n = Number(raw);
            const next = raw.trim() && Number.isFinite(n) ? clamp(n) : value;
            setRaw(String(next));
            if (next !== value) onChange(next);
          }}
        />
        {unit && <span className="shrink-0 text-[0.85rem] text-muted-foreground">{unit}</span>}
      </div>
      {hint && <p className="mt-1.5 text-[0.82rem] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ToggleRow({ title, note, warn, checked, onChange, disabled, children }: { title: string; note: ReactNode; warn?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children?: ReactNode }) {
  const id = useId();
  return (
    <div className="hairline border-b py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
          <span className="block font-medium">{title}</span>
          <span className="block text-[0.85rem] leading-snug text-muted-foreground">{note}</span>
          {warn && <span className="mt-1 block text-[0.82rem] leading-snug text-warn">{warn}</span>}
        </label>
      </div>
      {children && <div className="mt-3 pl-12">{children}</div>}
    </div>
  );
}

const MODES: { value: Mode; label: string; note: string }[] = [
  { value: "individual", label: "Individual", note: "Each lead works alone and unseen. Nobody reviews its claims, so nothing can rise above “Candidate proof”." },
  { value: "collaborative", label: "Collaborative", note: "Leads work blind in the first cycle, then share one ledger, check each other's claims and build on them." },
  { value: "debate", label: "Debate", note: "Leads work blind each cycle, then examine each other's claims adversarially: objection, rebuttal or fix, resolution." },
];

const SPEEDS: { value: Speed; label: string; note: string }[] = (["medium", "fast", "ultrafast"] as Speed[]).map((s) => ({
  value: s,
  label: s === "ultrafast" ? "Ultrafast" : s === "fast" ? "Fast" : "Medium",
  note: `Up to ${SPEED_CONCURRENCY[s]} model calls at once.`,
}));

export function TeamFields({ config, onChange, disabled }: FormProps) {
  const set = (p: Partial<RunConfig>): void => onChange({ ...config, ...p });
  return (
    <div className="space-y-6">
      <Field label="Lead models" hint="Each lead runs its own team. Requests go to exactly these model ids at the effort shown. If a provider refuses or fails, the real error is shown and no other model is substituted.">
        <ModelPicker label="Lead models" value={config.leads} onChange={(leads) => set({ leads })} disabled={disabled} />
      </Field>
      <Field label="Models for subagents" hint={`Leads hand sub-questions to subagents on these models. One run never creates more than ${SUBAGENT_HARD_CAP}.`}>
        <ModelPicker label="Models for subagents" value={config.subagentModels} onChange={(subagentModels) => set({ subagentModels })} disabled={disabled} />
      </Field>
      <Field label="How the leads work together" hint={config.leads.length < 2 && config.mode !== "individual" ? "With a single lead there is no second lead to review its claims." : undefined}>
        <Choice label="Mode" value={config.mode} options={MODES} onChange={(mode) => set({ mode })} disabled={disabled} />
      </Field>
      <Field label="Speed" hint="Speed only sets how many model calls run side by side. It never lowers the effort a model is asked for.">
        <Choice label="Speed" value={config.speed} options={SPEEDS} onChange={(speed) => set({ speed, limits: { ...config.limits, concurrency: SPEED_CONCURRENCY[speed] } })} disabled={disabled} />
      </Field>
    </div>
  );
}

export function LimitFields({ config, onChange, disabled, availableUsd }: FormProps & { availableUsd?: number }) {
  const l = config.limits;
  const set = (p: Partial<RunConfig["limits"]>): void => onChange({ ...config, limits: { ...l, ...p } });
  const over = availableUsd !== undefined && l.spendUsd > availableUsd;
  return (
    <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
      <div className="sm:col-span-2 lg:col-span-3">
        <NumberBox
          label="Spending limit for this run"
          value={l.spendUsd}
          min={1}
          max={20000}
          unit="USD of model use"
          disabled={disabled}
          onChange={(spendUsd) => set({ spendUsd })}
          hint={
            <>
              Set aside in full when the run starts and released when it ends; the run pauses before it could go past it.
              {availableUsd !== undefined && (
                <span className={over ? "text-warn" : ""}>
                  {" "}
                  {usd(Math.max(0, availableUsd))} of this month's ceiling is free{over ? ", so the run will be held to that amount." : "."}
                </span>
              )}
              {availableUsd !== undefined && availableUsd >= 1 && !disabled && Math.abs(l.spendUsd - availableUsd) > 0.004 && (
                <>
                  {" "}
                  <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => set({ spendUsd: Math.floor(availableUsd * 100) / 100 })}>
                    Use all of it
                  </button>
                </>
              )}
            </>
          }
        />
      </div>
      <div className="sm:col-span-2 lg:col-span-3">
        <ToggleRow
          title="Keep working until the spending limit is reached"
          note="The working-time and cycle limits below are not applied. The run goes on, cycle after cycle, until the goal is reached, the spending limit is used up, or you stop it."
          warn={l.untilSpend ? "It still pauses and asks you if every lead reports no progress two cycles in a row, or if today's free backend allowance runs low." : undefined}
          checked={l.untilSpend}
          onChange={(untilSpend) => set({ untilSpend })}
          disabled={disabled}
        />
      </div>
      <NumberBox label="Working time" value={l.runtimeMin} min={5} max={20160} unit={l.untilSpend ? "minutes, not applied" : "minutes"} disabled={disabled || l.untilSpend} onChange={(runtimeMin) => set({ runtimeMin: Math.round(runtimeMin) })} />
      <NumberBox label="Research cycles" value={l.maxCycles} min={1} max={500} unit={l.untilSpend ? "not applied" : "at most"} disabled={disabled || l.untilSpend} onChange={(maxCycles) => set({ maxCycles: Math.round(maxCycles) })} />
      <NumberBox label="Subagents" value={l.subagentCap} min={0} max={SUBAGENT_HARD_CAP} unit={`of ${SUBAGENT_HARD_CAP}`} disabled={disabled} onChange={(subagentCap) => set({ subagentCap: Math.round(subagentCap) })} />
      <NumberBox label="Delegation depth" value={l.maxDepth} min={1} max={DEPTH_HARD_CAP} unit={`of ${DEPTH_HARD_CAP}`} disabled={disabled} onChange={(maxDepth) => set({ maxDepth: Math.round(maxDepth) })} hint="At 1, only leads hand out work. At 2, a subagent may hand part of its question to its own subagents, and so on for each further level. The subagent total above still applies." />
    </div>
  );
}

const EXECUTORS: { value: SandboxExecutor; label: string; note: string }[] = [
  { value: "astra-shell", label: "OpenAI sandbox", note: `Code is run by ${MODELS.astra62.label}'s hosted shell.` },
  { value: "fable-bash", label: "Anthropic sandbox", note: `Code is run by ${MODELS.fable52.label}'s hosted shell.` },
];

/** `notes` carries what is known to be wrong with a tool right now, in the server's own words. */
export function ToolFields({ config, onChange, disabled, settings, notes = {} }: FormProps & { settings?: PublicSettings; notes?: Partial<Record<keyof RunTools, string>> }) {
  const t = config.tools;
  const set = (p: Partial<RunTools>): void => onChange({ ...config, tools: { ...t, ...p } });
  const exa = settings?.exaEnabled && settings.exaKeySet && settings.exaFreeConfirmed;
  const noLean = settings !== undefined && !settings.leanUrl;
  return (
    <div>
      <ToggleRow
        title="Web search"
        checked={t.web}
        disabled={disabled}
        onChange={(web) => set({ web })}
        warn={notes.web}
        note={`DuckDuckGo and Wikipedia, free and without a key.${exa ? ` Exa is also on, held to ${settings?.exaMonthlyCap ?? 0} searches a month.` : " Exa is off."} Pages are read as untrusted material.`}
      />
      <ToggleRow title="Literature search" checked={t.literature} disabled={disabled} onChange={(literature) => set({ literature })} warn={notes.literature} note="arXiv and Crossref. Titles, authors, dates and identifiers come from their answers, never from a model's memory." />
      <ToggleRow
        title="Code sandbox"
        checked={t.sandbox}
        disabled={disabled}
        onChange={(sandbox) => set({ sandbox })}
        warn={notes.sandbox}
        note="Python with SymPy, NumPy, SciPy and mpmath in an isolated sandbox that holds no credentials. Code, output, seed and runtime are saved with every experiment."
      >
        {t.sandbox && <Choice label="Sandbox" value={t.sandboxExecutor} options={EXECUTORS} onChange={(sandboxExecutor) => set({ sandboxExecutor })} disabled={disabled} />}
      </ToggleRow>
      <ToggleRow title="SageMath" checked={t.sage} disabled={disabled} onChange={(sage) => set({ sage })} warn={notes.sage} note="The public SageMathCell service. If it cannot be reached, the run records it as unavailable and carries on without it." />
      <ToggleRow
        title="Lean 4 with Mathlib"
        checked={t.lean && !noLean}
        disabled={disabled || noLean}
        onChange={(lean) => set({ lean })}
        warn={noLean ? "No Lean server address is set (Settings, Lean). Until one is, nothing can be labelled “Formally checked theorem”." : notes.lean}
        note="Formal statements are compiled on your Lean server. Only a check that passes with no sorry and no extra axioms counts as formal."
      />
      <ToggleRow title="OEIS" checked={t.oeis} disabled={disabled} onChange={(oeis) => set({ oeis })} warn={notes.oeis} note="Looks integer sequences up in the OEIS and links each entry it used." />
    </div>
  );
}

export function AlertFields({ config, onChange, disabled, settings }: FormProps & { settings?: PublicSettings }) {
  const a = config.alerts;
  const set = (p: Partial<RunConfig["alerts"]>): void => onChange({ ...config, alerts: { ...a, ...p } });
  const noMail = settings !== undefined && !settings.email.configured;
  const noDrive = settings !== undefined && !settings.drive.connected;
  return (
    <div>
      <ToggleRow
        title="Email updates"
        checked={a.enabled}
        disabled={disabled}
        onChange={(enabled) => set({ enabled })}
        note={`A progress digest${settings?.email.recipient ? ` to ${settings.email.recipient}` : ""} while the run is working. The run keeps going when you are signed out.`}
        warn={noMail ? "Email delivery is not set up yet, so nothing will be sent. The run itself is not affected." : undefined}
      >
        {a.enabled && (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_1fr]">
            <NumberBox label="Digest every" value={a.intervalMin} min={5} max={1440} unit="minutes" disabled={disabled} onChange={(intervalMin) => set({ intervalMin: Math.round(intervalMin) })} />
            <div className="space-y-2 self-end pb-1 text-[0.9rem]">
              <label className="flex items-center gap-2.5">
                <Switch checked={a.onGoal} onCheckedChange={(onGoal) => set({ onGoal })} disabled={disabled} /> When the goal is reached
              </label>
              <label className="flex items-center gap-2.5">
                <Switch checked={a.onAttention} onCheckedChange={(onAttention) => set({ onAttention })} disabled={disabled} /> When the run needs me
              </label>
            </div>
          </div>
        )}
      </ToggleRow>
      <ToggleRow
        title="Save to Google Drive"
        checked={config.drive && !noDrive}
        disabled={disabled || noDrive}
        onChange={(drive) => onChange({ ...config, drive })}
        note="Copies the report and the files the agents produce into this run's own folder inside your Scholium folder, and lists every file it uploaded. It never reads or touches anything else in your Drive."
        warn={noDrive ? "Google Drive is not connected (Settings, Google Drive)." : undefined}
      />
    </div>
  );
}
