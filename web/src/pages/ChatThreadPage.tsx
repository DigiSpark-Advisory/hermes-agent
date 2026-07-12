/**
 * ChatThreadPage — the Claude-shaped chat client (reskin Phase 2).
 *
 * Replaces the xterm/PTY mirror as the /chat route: a calm streaming message
 * thread over the gateway's JSON-RPC WebSocket (session.create /
 * session.resume / prompt.submit + streaming events), with collapsible
 * tool-call chips, blocking-prompt handling (approvals, clarify, secrets),
 * and a clean composer. The old terminal mirror lives on at /terminal
 * (behind the sidebar's Advanced disclosure) for power use.
 *
 * `?resume=<session id>` opens an existing conversation; the page is keyed
 * on that param by the route wrapper so switching sessions remounts cleanly.
 *
 * v1.3: the whole chat surface scales via CSS `zoom` (composer stepper,
 * 90–140%, persisted in localStorage) — font AND spacing relax together.
 */

import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Button } from "@nous-research/ui/ui/components/button";
import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { Markdown } from "@/components/Markdown";
import { PromptBar } from "@/components/thread/PromptBar";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { ToolChipGroup } from "@/components/thread/ToolChip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  useChatThread,
  type ThreadItem,
} from "@/hooks/useChatThread";

const RENDER_BUDGET = 250;

// v1.3 zoom steps. CSS `zoom` scales text AND spacing together — the
// "too small and too dense" complaint in one knob. Persisted per browser.
const ZOOM_STEPS = [0.9, 1, 1.1, 1.25, 1.4];
const ZOOM_KEY = "digispark-chat-zoom";

function ReasoningDisclosure({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const effectiveOpen = open ?? streaming; // auto-open while streaming
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setOpen(!effectiveOpen)}
        className={cn(
          "cursor-pointer rounded border-0 bg-transparent px-1 py-0.5",
          "text-xs text-text-tertiary hover:text-text-secondary",
        )}
        aria-expanded={effectiveOpen}
      >
        {streaming ? "Thinking…" : "Thought process"} {effectiveOpen ? "▾" : "▸"}
      </button>
      {effectiveOpen && (
        <div className="mt-1 max-h-48 overflow-y-auto rounded border-l-2 border-current/10 pl-3 text-xs leading-relaxed text-text-tertiary whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

function ThreadItemView({ item }: { item: ThreadItem }) {
  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <div
          className={cn(
            "max-w-[78%] rounded-xl border border-current/10 px-4 py-2.5",
            "bg-[color-mix(in_srgb,var(--ds-accent)_8%,var(--background-base))]",
            "whitespace-pre-wrap text-[0.95rem] leading-relaxed",
          )}
        >
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    if (!item.text && !item.reasoning) return null;
    return (
      <div className="max-w-[92%]">
        {item.reasoning && (
          <ReasoningDisclosure
            text={item.reasoning}
            streaming={Boolean(item.reasoningStreaming)}
          />
        )}
        {(item.text || item.streaming) && (
          <div className="text-[0.95rem] leading-relaxed">
            <Markdown content={item.text} streaming={item.streaming} />
          </div>
        )}
      </div>
    );
  }
  if (item.kind === "tools") {
    return <ToolChipGroup calls={item.calls} />;
  }
  return (
    <div
      className={cn(
        "flex max-w-[92%] items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        item.tone === "error"
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-current/10 bg-midground/3 text-text-tertiary",
      )}
    >
      {item.tone === "error" && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span className="whitespace-pre-wrap">{item.text}</span>
    </div>
  );
}

function ChatThread({ resumeId }: { resumeId: string | null }) {
  const thread = useChatThread(resumeId);
  const [showAll, setShowAll] = useState(false);
  const [fallbackModel, setFallbackModel] = useState<string | undefined>();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  // v1.3 zoom — index into ZOOM_STEPS, persisted per browser.
  const [zoomIdx, setZoomIdx] = useState(() => {
    try {
      const v = Number(window.localStorage.getItem(ZOOM_KEY));
      const idx = ZOOM_STEPS.indexOf(v);
      return idx >= 0 ? idx : ZOOM_STEPS.indexOf(1);
    } catch {
      return ZOOM_STEPS.indexOf(1);
    }
  });
  const zoom = ZOOM_STEPS[zoomIdx];
  const setZoom = useCallback((idx: number) => {
    const clamped = Math.min(ZOOM_STEPS.length - 1, Math.max(0, idx));
    setZoomIdx(clamped);
    try {
      window.localStorage.setItem(ZOOM_KEY, String(ZOOM_STEPS[clamped]));
    } catch { /* private browsing */ }
  }, []);
  const zoomIn = useCallback(() => setZoom(zoomIdx + 1), [setZoom, zoomIdx]);
  const zoomOut = useCallback(() => setZoom(zoomIdx - 1), [setZoom, zoomIdx]);
  const zoomReset = useCallback(
    () => setZoom(ZOOM_STEPS.indexOf(1)),
    [setZoom],
  );

  // Model pill before any session exists: read the effective config model.
  useEffect(() => {
    if (thread.info.model) return;
    let cancelled = false;
    api
      .getModelInfo()
      .then((m) => {
        if (!cancelled && m?.model) setFallbackModel(m.model);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [thread.info.model]);

  // Stick-to-bottom: follow the stream unless the user scrolled up.
  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [thread.items, thread.statusLine, thread.prompt]);

  const visibleItems = useMemo(() => {
    if (showAll || thread.items.length <= RENDER_BUDGET) return thread.items;
    return thread.items.slice(-RENDER_BUDGET);
  }, [thread.items, showAll]);
  const hiddenCount = thread.items.length - visibleItems.length;

  const connecting =
    thread.connection === "connecting" || thread.connection === "idle";
  const disconnected =
    thread.connection === "closed" || thread.connection === "error";
  const empty = thread.items.length === 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ zoom }}>
      {/* Connection / resume problems — quiet, non-modal */}
      {disconnected && (
        <div className="mx-auto mt-2 w-full max-w-4xl rounded border border-warning/50 bg-warning/10 px-3 py-1.5 text-xs text-warning">
          Connection lost — reconnecting…
          {thread.connectionError ? ` (${thread.connectionError})` : ""}
        </div>
      )}
      {thread.resumeFailed && (
        <div className="mx-auto mt-2 w-full max-w-4xl rounded border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
          Couldn't resume this conversation: {thread.resumeFailed}
        </div>
      )}

      {/* Thread */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-1 py-6">
          {hiddenCount > 0 && (
            <div className="text-center">
              <Button size="sm" ghost onClick={() => setShowAll(true)}
                className="normal-case tracking-normal text-text-tertiary">
                Show {hiddenCount} earlier
              </Button>
            </div>
          )}

          {empty && !connecting && (
            <div className="flex flex-col items-center gap-1 py-24 text-center">
              <div className="text-lg font-semibold text-text-primary">
                {resumeId ? "Loading conversation…" : "What's on deck?"}
              </div>
              <div className="text-sm text-text-tertiary">
                Inbox triage, the news feeds, or a research question.
              </div>
            </div>
          )}
          {empty && connecting && (
            <div className="flex items-center justify-center gap-2 py-24 text-sm text-text-tertiary">
              <Spinner aria-label="connecting" /> Connecting to the agent…
            </div>
          )}

          {visibleItems.map((item) => (
            <ThreadItemView key={item.id} item={item} />
          ))}

          {/* Live status: spinner + optional status line while working */}
          {thread.running && (
            <div className="flex items-center gap-2 text-xs text-text-tertiary">
              <Spinner aria-label="working" className="text-[var(--ds-accent)]" />
              <span>{thread.statusLine ?? "Working…"}</span>
            </div>
          )}
        </div>
      </div>

      {/* Blocking prompt (approval / clarify / secret) above the composer */}
      {thread.prompt && (
        <div className="mx-auto w-full max-w-4xl px-1 pb-2">
          <PromptBar
            prompt={thread.prompt}
            onApproval={(c) => void thread.respondApproval(c)}
            onClarify={(a) => void thread.respondClarify(a)}
            onSecret={(v) => void thread.respondSecret(v)}
          />
        </div>
      )}

      <ThreadComposer
        disabled={thread.connection !== "open"}
        running={thread.running}
        model={thread.info.model ?? fallbackModel}
        toolCount={thread.info.toolCount}
        onSend={(t) => void thread.send(t)}
        onStop={() => void thread.interrupt()}
        hint="Read-only analyst — replies are staged to Outlook Drafts, never sent."
        zoomPct={Math.round(zoom * 100)}
        canZoomIn={zoomIdx < ZOOM_STEPS.length - 1}
        canZoomOut={zoomIdx > 0}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomReset={zoomReset}
      />
    </div>
  );
}

export default function ChatThreadPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const resumeId = searchParams.get("resume");
  // Key on the resume target — or, for fresh threads, on the router's
  // per-navigation location.key. The old static "@new" key was the
  // new-chat-button bug: a /chat → /chat navigation never changed the key,
  // so the thread never remounted and the button appeared dead until a full
  // page reload. location.key is unique per history push, so every New chat
  // click tears down the socket + state and mounts a clean thread, while a
  // plain refresh (location.key === "default") stays stable.
  return (
    <ChatThread key={resumeId ?? `@new:${location.key}`} resumeId={resumeId} />
  );
}
