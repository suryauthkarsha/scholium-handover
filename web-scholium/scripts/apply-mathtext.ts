// One-off: routes the plain-text places that can contain formulas through <MathText>. Kept as a record of what was changed.
import { readFileSync, writeFileSync } from "node:fs";

const edits: Record<string, [string, string][]> = {
  "src/components/run/Transcript.tsx": [
    ['import { Code, Markdown } from "@/components/Markdown";', 'import { Code, Markdown, MathText } from "@/components/Markdown";\nimport { tailText } from "@/shared/math";'],
    ["{long && !all ? `${text.slice(0, 600)}…` : text}</p>", "<MathText text={long && !all ? `${text.slice(0, 600)}…` : text} /></p>"],
    ["{m.thinking}</p>", "<MathText text={m.thinking} /></p>"],
    ["{live.slice(-4000)}</p>", "<MathText text={tailText(live, 4000)} /></p>"],
  ],
  "src/components/run/Research.tsx": [
    ['import { Markdown, Ref } from "@/components/Markdown";', 'import { Markdown, MathText, Ref } from "@/components/Markdown";\nimport { tailText } from "@/shared/math";'],
    ["          {task.title}\n", "          <MathText text={task.title} />\n"],
    ["{live.slice(-1200)}</p>", "<MathText text={tailText(live, 1200)} /></p>"],
  ],
  "src/components/run/Records.tsx": [
    ['import { Ref } from "@/components/Markdown";', 'import { MathText, Ref } from "@/components/Markdown";'],
    ["                {a.title}\n", "                <MathText text={a.title} />\n"],
    ["{brief(k.summary, 320)}</span>", "<MathText text={brief(k.summary, 320)} /></span>"],
  ],
  "src/components/run/Detail.tsx": [
    ['import { Code, Markdown, Ref } from "@/components/Markdown";', 'import { Code, Markdown, MathText, Ref } from "@/components/Markdown";'],
    ['<span className="min-w-0 flex-1 truncate">{t.title}</span>', '<span className="min-w-0 flex-1 truncate"><MathText text={t.title} /></span>'],
    ['<p className="whitespace-pre-wrap break-words font-serif text-[0.93rem]">{s.snippet}</p>', '<p className="whitespace-pre-wrap break-words font-serif text-[0.93rem]"><MathText text={s.snippet} /></p>'],
    ['<p className="whitespace-pre-wrap break-words text-sm">{f.item.text}</p>', '<p className="whitespace-pre-wrap break-words text-sm"><MathText text={f.item.text} /></p>'],
  ],
  "src/components/run/Evidence.tsx": [
    ['import { Ref } from "@/components/Markdown";', 'import { MathText, Ref } from "@/components/Markdown";'],
    ["{brief(r.c.statement, 110)}", "<MathText text={brief(r.c.statement, 110)} />"],
    ["{brief(r.summary, 420)}", "<MathText text={brief(r.summary, 420)} />"],
    ["{url ? <Ext href={url}>{s.title || url}</Ext> : s.title}", "{url ? <Ext href={url}><MathText text={s.title || url} /></Ext> : <MathText text={s.title} />}"],
  ],
  "src/components/run/Agents.tsx": [
    ['import { brief, useRunCtx } from "./ctx";', 'import { MathText } from "@/components/Markdown";\n\nimport { brief, useRunCtx } from "./ctx";'],
    ["{brief(a.assignment?.question ?? a.role, 220)}</span>", "<MathText text={brief(a.assignment?.question ?? a.role, 220)} /></span>"],
  ],
  "src/components/run/Composer.tsx": [
    ['import { Ref } from "@/components/Markdown";', 'import { MathText, Ref } from "@/components/Markdown";'],
    ['<p className="whitespace-pre-wrap break-words">{i.text}</p>', '<p className="whitespace-pre-wrap break-words"><MathText text={i.text} /></p>'],
    ['<p className="whitespace-pre-wrap break-words">{i.text}</p>', '<p className="whitespace-pre-wrap break-words"><MathText text={i.text} /></p>'],
    ["{e.text} {e.ref ?", "<MathText text={e.text} /> {e.ref ?"],
  ],
  "src/components/Shell.tsx": [
    ['import { Meter, STATUS, usd } from "@/components/bits";', 'import { Meter, STATUS, usd } from "@/components/bits";\nimport { MathText } from "@/components/Markdown";'],
    ['{run.title || run.goal || "Untitled project"}</span>', '<MathText text={run.title || run.goal || "Untitled project"} /></span>'],
  ],
  "src/pages/Projects.tsx": [
    ["{run.goal}</p>}", "<MathText text={run.goal} /></p>}"],
  ],
  "src/components/Methods.tsx": [
    ['import { Chip, ErrorNote, Loading, usd } from "@/components/bits";', 'import { Chip, ErrorNote, Loading, usd } from "@/components/bits";\nimport { MathText } from "@/components/Markdown";'],
    ["leading-relaxed\">{v.text}</p>}", "leading-relaxed\"><MathText text={v.text} /></p>}"],
  ],
};
for (const [file, list] of Object.entries(edits)) {
  let src = readFileSync(file, "utf8");
  for (const [from, to] of list) {
    if (!src.includes(from)) {
      console.log(`MISSING in ${file}: ${from.slice(0, 70)}`);
      continue;
    }
    src = src.replace(from, () => to);
  }
  writeFileSync(file, src);
}
