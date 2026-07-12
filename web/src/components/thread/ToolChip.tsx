/**
 * ToolChip — the quiet, collapsible tool-call affordance from the reskin
 * spec. Collapsed: status glyph + mono tool name + duration. Expanded: the
 * call's args and output as plain mono text. Interaction design follows the
 * desktop's tool/fallback.tsx, radically simplified.
 *
 * v1.3: ToolChipGroup nests a turn's tool burst — 2+ calls collapse to ONE
 * summary row ("N tool calls · search_files ×5") that expands to the chip
 * list. Keeps the thread reading as dialogue; a single call renders as the
 * plain chip (a group header for one call would just be noise).
 */

import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { AlertCircle, Check, ChevronRight, Wrench } from "lucide-react";
import { useMemo, useState } from "react";

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
  const [open, setOpen] = useState(false);

  const running = calls.some((c) => c.phase !== "complete");
  const errorCount = calls.filter((c) => c.isError).length;

  // "search_files ×5 · get_entries" — stable order of first appearance.
  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    return [...counts.entries()]
      .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
      .join(" · ");
  }, [calls]);

  // A single call needs no group header — the chip IS one quiet row.
  if (calls.length === 1) {
    return (
      <div className="flex max-w-[92%] flex-col gap-1.5">
        <ToolChip call={calls[0]} />
      </div>
    );
  }

  return (
    <div className="flex max-w-[92%] flex-col gap-1.5">
      <div
        className={cn(
          "overflow-hidden rounded-lg border border-current/10 bg-card shadow-sm",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left",
            "bg-transparent border-0 hover:bg-midground/4",
          )}
        >
          {running ? (
            <Spinner aria-label="running" className="h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" />
          ) : errorCount > 0 ? (
            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          ) : (
            <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ds-green)]" />
          )}
          <Wrench className="h-3 w-3 shrink-0 text-text-tertiary" aria-hidden />
          <span className="shrink-0 text-xs font-medium text-text-primary">
            {calls.length} tool calls
          </span>
          <span className="truncate font-mono-ui text-[0.6875rem] text-text-tertiary">
            {summary}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2 text-[0.6875rem] text-text-tertiary">
            {running && <span>running…</span>}
            {!running && errorCount > 0 && (
              <span className="text-destructive">{errorCount} failed</span>
            )}
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform duration-150",
                open && "rotate-90",
              )}
            />
          </span>
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-1.5 border-l-2 border-current/10 pl-2">
          {calls.map((c) => (
            <ToolChip key={c.toolId} call={c} />
          ))}
        </div>
      )}
    </div>
  );
}
