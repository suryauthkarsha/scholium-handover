import { Paperclip } from "lucide-react";
import { useRef, useState } from "react";

import { ACCEPT } from "@/lib/files";

/** A place to drop or choose files. What happens to them is up to the screen that uses it. */
export function FileDrop({ onFiles, disabled = false, compact = false }: { onFiles: (files: File[]) => void; disabled?: boolean; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled && e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
      }}
      className={`rounded-sm border border-dashed text-center transition-colors ${over ? "border-rubric bg-rubric-soft" : "border-foreground/25"} ${compact ? "px-3 py-3" : "px-5 py-7"} ${disabled ? "opacity-60" : ""}`}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          e.target.value = "";
          if (picked.length) onFiles(picked);
        }}
      />
      <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-[0.95rem]">
        <Paperclip className="h-4 w-4 text-muted-foreground" />
        Drop files here, or
        <button type="button" disabled={disabled} onClick={() => input.current?.click()} className="font-medium text-rubric underline underline-offset-4">
          choose them
        </button>
      </p>
      {!compact && (
        <p className="mx-auto mt-1.5 max-w-lg text-[0.82rem] leading-relaxed text-muted-foreground">
          Papers, notes, data, code and images, up to 12 MB each. The text of a PDF is read in your browser. Whatever a file says is treated as material to study, never as instructions to follow.
        </p>
      )}
    </div>
  );
}
