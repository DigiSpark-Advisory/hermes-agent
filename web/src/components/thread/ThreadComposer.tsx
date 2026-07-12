/**
 * ThreadComposer — the single clean input from the reskin spec: autosize
 * textarea, Enter to send (Shift+Enter for newline), a quiet model pill that
 * opens the standalone ModelPickerDialog, the session tool count, and a
 * Send / Stop button.
 *
 * Mobile notes (v1.2): the textarea is text-base (16px) below the sm
 * breakpoint — anything smaller trips iOS Safari's zoom-on-focus — and the
 * wrapper's bottom padding honours env(safe-area-inset-bottom) so the
 * composer clears the iPhone home indicator.
 *
 * v1.3: optional zoom stepper (A− / % / A+) — the page owns the zoom state
 * and applies it to the whole chat surface; the stepper only renders when
 * the zoom props are provided. Clicking the % label resets to 100.
 */

import { Button } from "@nous-research/ui/ui/components/button";
import { ArrowUp, ChevronDown, Square, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ModelPickerDialog } from "@/components/ModelPickerDialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Props {
  disabled: boolean;
  running: boolean;
  model?: string;
  toolCount?: number;
  onSend(text: string): void;
  onStop(): void;
  /** Shown under the composer — the read-only posture hint. */
  hint?: string;
  /** v1.3 zoom stepper — all-or-nothing: render only when provided. */
  zoomPct?: number;
  canZoomIn?: boolean;
  canZoomOut?: boolean;
  onZoomIn?(): void;
  onZoomOut?(): void;
  onZoomReset?(): void;
}

export function ThreadComposer({
  disabled,
  running,
  model,
  toolCount,
  onSend,
  onStop,
  hint,
  zoomPct,
  canZoomIn,
  canZoomOut,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: Props) {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const autosize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);
  useEffect(autosize, [text, autosize]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled || running) return;
    onSend(trimmed);
    setText("");
  }, [text, disabled, running, onSend]);

  const zoomControls = zoomPct != null && onZoomIn && onZoomOut;

  return (
    <div className="mx-auto w-full max-w-4xl px-1 pb-[max(1rem,env(safe-area-inset-bottom,0px))]">
      <div
        className={cn(
          "rounded-xl border border-current/10 bg-card shadow-md",
          "px-3.5 pb-2.5 pt-3",
        )}
      >
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? "Connecting…" : "Message Hermes…"}
          aria-label="Message Hermes"
          className={cn(
            "w-full resize-none border-0 bg-transparent outline-none",
            "font-sans text-base sm:text-[0.95rem] leading-relaxed text-text-primary",
            "placeholder:text-text-tertiary",
          )}
        />

        <div className="mt-1.5 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className={cn(
              "flex cursor-pointer items-center gap-1 rounded border-0 bg-transparent px-1.5 py-1",
              "font-mono-ui text-xs text-text-tertiary",
              "hover:bg-midground/5 hover:text-text-secondary",
            )}
            title="Switch model (applies to the next chat)"
          >
            {model ?? "model"}
            <ChevronDown className="h-3 w-3" />
          </button>

          {toolCount != null && toolCount > 0 && (
            <span className="text-xs text-text-tertiary">{toolCount} tools</span>
          )}

          {modelNotice && (
            <span className="truncate text-xs text-[var(--ds-green)]">{modelNotice}</span>
          )}

          {zoomControls && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={onZoomOut}
                disabled={!canZoomOut}
                aria-label="Decrease text size"
                title="Decrease text size"
                className={cn(
                  "flex h-6 w-6 cursor-pointer items-center justify-center rounded",
                  "border-0 bg-transparent text-text-tertiary",
                  "hover:bg-midground/5 hover:text-text-secondary",
                  "disabled:cursor-default disabled:opacity-35",
                )}
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              {zoomPct !== 100 && (
                <button
                  type="button"
                  onClick={onZoomReset}
                  aria-label="Reset text size"
                  title="Reset to 100%"
                  className={cn(
                    "cursor-pointer rounded border-0 bg-transparent px-1 py-0.5",
                    "font-mono-ui text-[0.6875rem] tabular-nums text-text-tertiary",
                    "hover:text-text-secondary",
                  )}
                >
                  {zoomPct}%
                </button>
              )}
              <button
                type="button"
                onClick={onZoomIn}
                disabled={!canZoomIn}
                aria-label="Increase text size"
                title="Increase text size"
                className={cn(
                  "flex h-6 w-6 cursor-pointer items-center justify-center rounded",
                  "border-0 bg-transparent text-text-tertiary",
                  "hover:bg-midground/5 hover:text-text-secondary",
                  "disabled:cursor-default disabled:opacity-35",
                )}
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
            </span>
          )}

          {running ? (
            <Button
              size="icon"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop generating"
              className={cn(
                "h-8 w-8 shrink-0 !bg-midground/10 !text-text-primary hover:!bg-midground/20",
                zoomControls ? "ml-1" : "ml-auto",
              )}
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={submit}
              disabled={disabled || !text.trim()}
              aria-label="Send message"
              className={cn(
                "h-8 w-8 shrink-0",
                zoomControls ? "ml-1" : "ml-auto",
                "!bg-[var(--ds-accent)] !text-white hover:!bg-[var(--ds-accent-hover)]",
                "disabled:opacity-40",
              )}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {hint && (
        <div className="mt-2 text-center text-[0.6875rem] text-text-tertiary">{hint}</div>
      )}

      {pickerOpen && (
        <ModelPickerDialog
          title="Switch model"
          alwaysGlobal
          loader={(opts) => api.getModelOptions({ refresh: opts?.refresh })}
          onApply={async ({ provider, model: m, confirmExpensiveModel }) => {
            const res = await api.setModelAssignment({
              scope: "main",
              provider,
              model: m,
              confirm_expensive_model: confirmExpensiveModel,
            });
            // confirm_required => the dialog shows the expensive-model prompt
            // and calls back; don't announce until the user confirms.
            if (!res.confirm_required) {
              setModelNotice(
                `Model set to ${m.split("/").slice(-1)[0]} — applies to the next chat`,
              );
              setTimeout(() => setModelNotice(null), 6000);
            }
            return res;
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
