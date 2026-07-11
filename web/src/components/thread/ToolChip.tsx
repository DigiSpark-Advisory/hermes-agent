/**
 * ToolChip — the quiet, collapsible tool-call affordance from the reskin
 * spec. Collapsed: status glyph + mono tool name + duration. Expanded: the
 * call's args and output as plain mono text. Interaction design follows the
 * desktop's tool/fallback.tsx, radically simplified.
 */

import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { AlertCircle, Check, ChevronRight, Wrench } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import type { ThreadToolCall } from "@/hooks/useChatThread";

const OUTPUT_CAP = 20_000;

function clip(text: string): string {
  return text.length > OUTPUT_CAP
    ? text.slice(0, OUTPUT_CAP) + "\n…[truncated]"
    : text;
}

export function ToolChip({ call }: { call: ThreadToolCall }) {
  const [open, setOpen] = useState(false);
  const runningLike = call.phase !== "complete";
  const hasBody = Boolean(call.argsText || call.resultText || call.error || call.summary);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-current/10 bg-card",
        "shadow-sm",
      )}
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2 text-left",
          "bg-transparent border-0",
          hasBody ? "cursor-pointer hover:bg-midground/4" : "cursor-default",
        )}
      >
        {runningLike ? (
          <Spinner aria-label="running" className="h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" />
        ) : call.isError ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ds-green)]" />
        )}
        <Wrench className="h-3 w-3 shrink-0 text-text-tertiary" aria-hidden />
        <span className="truncate font-mono-ui text-xs text-text-primary">
          {call.name}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[0.6875rem] text-text-tertiary">
          {call.phase === "generating" && <span>preparing…</span>}
          {call.phase === "running" && <span>running…</span>}
          {call.durationS != null && call.phase === "complete" && (
            <span>{call.durationS < 10 ? call.durationS.toFixed(1) : Math.round(call.durationS)}s</span>
          )}
          {hasBody && (
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform duration-150",
                open && "rotate-90",
              )}
            />
          )}
        </span>
      </button>

      {open && hasBody && (
        <div className="border-t border-current/10 bg-midground/3 px-3 py-2">
          {call.argsText && (
            <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono-ui text-[0.6875rem] leading-relaxed text-text-tertiary">
              {clip(call.argsText)}
            </pre>
          )}
          {(call.error || call.resultText || call.summary) && (
            <pre
              className={cn(
                "max-h-72 overflow-auto whitespace-pre-wrap font-mono-ui text-xs leading-relaxed",
                call.isError ? "text-destructive" : "text-text-secondary",
              )}
            >
              {clip(call.error || call.resultText || call.summary || "")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolChipGroup({ calls }: { calls: ThreadToolCall[] }) {
  return (
    <div className="flex max-w-[92%] flex-col gap-1.5">
      {calls.map((c) => (
        <ToolChip key={c.toolId} call={c} />
      ))}
    </div>
  );
}
