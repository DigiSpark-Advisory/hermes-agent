/**
 * useChatThread — the engine behind the message-thread chat page.
 *
 * Owns one GatewayClient WebSocket (/api/ws, JSON-RPC) and reduces the
 * gateway's streaming events into renderable thread items. The event → state
 * mapping mirrors the desktop app's
 * `apps/desktop/src/app/session/hooks/use-message-stream/gateway-event.ts`
 * (the authoritative reference), minus desktop-only side effects.
 *
 * Session model:
 *  - A fresh thread creates its gateway session LAZILY on the first send
 *    (avoids littering the session list with empty "web" sessions).
 *  - `?resume=<id>` calls `session.resume`, which returns the transcript
 *    backfill and the LIVE session id used for all subsequent calls.
 *  - On reconnect (socket drop), an existing session is re-resumed and the
 *    thread re-renders from the server-authoritative transcript.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { GatewayClient, type ConnectionState, type GatewayEvent } from "@/lib/gatewayClient";

// ── Thread state types ──────────────────────────────────────────────────────────────

export interface ThreadToolCall {
  toolId: string;
  name: string;
  argsText?: string;
  resultText?: string;
  summary?: string;
  error?: string;
  durationS?: number;
  phase: "generating" | "running" | "complete";
  isError: boolean;
}

export type ThreadItem =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      text: string;
      reasoning?: string;
      reasoningStreaming?: boolean;
      streaming: boolean;
    }
  | { kind: "tools"; id: string; calls: ThreadToolCall[] }
  | { kind: "system"; id: string; text: string; tone: "info" | "error" };

export interface PendingPrompt {
  kind: "approval" | "clarify" | "sudo" | "secret";
  /** approval */
  command?: string;
  description?: string;
  allowPermanent?: boolean;
  /** clarify */
  question?: string;
  choices?: string[] | null;
  /** sudo / secret */
  envVar?: string;
  promptText?: string;
  requestId?: string;
}

export interface ThreadSessionInfo {
  model?: string;
  provider?: string;
  running?: boolean;
  title?: string;
  toolCount?: number;
  /** v1.3: tool names from the session.info tools map (rail Session tab). */
  toolNames?: string[];
  reasoningEffort?: string;
  cwd?: string;
}

interface GatewayTranscriptMessage {
  role: "user" | "assistant" | "system" | "tool";
  text?: string;
  name?: string;
}

interface SessionResumeResponse {
  session_id: string;
  messages?: GatewayTranscriptMessage[];
  info?: Record<string, unknown>;
  running?: boolean;
}

interface SessionCreateResponse {
  session_id: string;
  info?: Record<string, unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────

let idCounter = 0;
const nextId = () => `t${++idCounter}`;

function infoFromPayload(payload: Record<string, unknown> | undefined): ThreadSessionInfo {
  const p = payload ?? {};
  const tools = p.tools;
  const toolsIsMap = Boolean(tools && typeof tools === "object");
  return {
    model: typeof p.model === "string" ? p.model : undefined,
    provider: typeof p.provider === "string" ? p.provider : undefined,
    running: typeof p.running === "boolean" ? p.running : undefined,
    title: typeof p.title === "string" ? p.title : undefined,
    reasoningEffort:
      typeof p.reasoning_effort === "string" ? p.reasoning_effort : undefined,
    cwd: typeof p.cwd === "string" ? p.cwd : undefined,
    toolCount: toolsIsMap ? Object.keys(tools as object).length : undefined,
    toolNames: toolsIsMap ? Object.keys(tools as object).sort() : undefined,
  };
}

function backfillToItems(messages: GatewayTranscriptMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const m of messages) {
    const text = (m.text ?? "").trim();
    if (!text && m.role !== "tool") continue;
    if (m.role === "user") {
      items.push({ kind: "user", id: nextId(), text });
    } else if (m.role === "assistant") {
      items.push({ kind: "assistant", id: nextId(), text, streaming: false });
    } else if (m.role === "tool") {
      items.push({
        kind: "tools",
        id: nextId(),
        calls: [
          {
            toolId: nextId(),
            name: m.name || "tool",
            resultText: text || undefined,
            phase: "complete",
            isError: false,
          },
        ],
      });
    } else {
      items.push({ kind: "system", id: nextId(), text, tone: "info" });
    }
  }
  return items;
}

// ── The hook ───────────────────────────────────────────────────────────────────────

export interface UseChatThread {
  items: ThreadItem[];
  connection: ConnectionState;
  connectionError: string | null;
  running: boolean;
  statusLine: string | null;
  info: ThreadSessionInfo;
  prompt: PendingPrompt | null;
  sessionId: string | null;
  resumeFailed: string | null;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  respondApproval(choice: "once" | "session" | "always" | "deny"): Promise<void>;
  respondClarify(answer: string): Promise<void>;
  respondSecret(value: string): Promise<void>;
}

export function useChatThread(resumeId: string | null): UseChatThread {
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [info, setInfo] = useState<ThreadSessionInfo>({});
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resumeFailed, setResumeFailed] = useState<string | null>(null);

  const gwRef = useRef<GatewayClient | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(1000);
  // Text accumulated from message.delta for the CURRENT turn, across all
  // assistant segments — used to sanity-check against message.complete.
  const turnAccum = useRef("");
  const sawDeltaThisTurn = useRef(false);

  const setSession = useCallback((id: string | null) => {
    sessionIdRef.current = id;
    setSessionId(id);
  }, []);

  // ── Event reducers (operate on the items array immutably) ────────────────────────

  const appendAssistantDelta = useCallback((text: string) => {
    if (!text) return;
    turnAccum.current += text;
    sawDeltaThisTurn.current = true;
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        const updated = { ...last, text: last.text + text };
        return [...prev.slice(0, -1), updated];
      }
      return [
        ...prev,
        { kind: "assistant", id: nextId(), text, streaming: true },
      ];
    });
  }, []);

  const appendReasoning = useCallback((text: string, replace: boolean) => {
    if (!text) return;
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        const updated = {
          ...last,
          reasoning: replace ? text : (last.reasoning ?? "") + text,
          reasoningStreaming: !replace,
        };
        return [...prev.slice(0, -1), updated];
      }
      return [
        ...prev,
        {
          kind: "assistant",
          id: nextId(),
          text: "",
          reasoning: text,
          reasoningStreaming: !replace,
          streaming: true,
        },
      ];
    });
  }, []);

  const upsertTool = useCallback(
    (
      toolId: string,
      patch: Partial<ThreadToolCall> & { name?: string },
      create: boolean,
    ) => {
      setItems((prev) => {
        // Find the tool call anywhere in the trailing tools groups of the
        // current turn (tool events can interleave with text segments).
        for (let i = prev.length - 1; i >= 0; i--) {
          const item = prev[i];
          if (item.kind === "user") break; // turn boundary
          if (item.kind !== "tools") continue;
          const idx = item.calls.findIndex((c) => c.toolId === toolId);
          if (idx === -1) continue;
          const calls = [...item.calls];
          calls[idx] = { ...calls[idx], ...patch };
          const next = [...prev];
          next[i] = { ...item, calls };
          return next;
        }
        if (!create) return prev;
        const call: ThreadToolCall = {
          toolId,
          name: patch.name || "tool",
          argsText: patch.argsText,
          phase: patch.phase ?? "running",
          isError: false,
        };
        // Seal the current streaming assistant segment so post-tool text
        // starts a new bubble below the chips (preserves visual order).
        const sealed = prev.map((it) =>
          it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it,
        );
        const last = sealed[sealed.length - 1];
        if (last && last.kind === "tools") {
          const next = [...sealed.slice(0, -1)];
          next.push({ ...last, calls: [...last.calls, call] });
          return next;
        }
        return [...sealed, { kind: "tools", id: nextId(), calls: [call] }];
      });
    },
    [],
  );

  const finishTurn = useCallback((finalText?: string) => {
    setRunning(false);
    setStatusLine(null);
    setItems((prev) => {
      let next = prev.map((it) =>
        it.kind === "assistant" && it.streaming
          ? { ...it, streaming: false, reasoningStreaming: false }
          : it,
      );
      const accumulated = turnAccum.current.trim();
      const complete = (finalText ?? "").trim();
      if (!sawDeltaThisTurn.current && complete) {
        // No deltas arrived (non-streaming path) — render the final text.
        next = [
          ...next,
          { kind: "assistant", id: nextId(), text: complete, streaming: false },
        ];
      } else if (
        complete &&
        accumulated &&
        complete.length > accumulated.length + 8
      ) {
        // Deltas were partial (rare). Append the missing tail as a segment
        // rather than reordering the whole turn.
        const tail = complete.startsWith(accumulated)
          ? complete.slice(accumulated.length)
          : null;
        if (tail && tail.trim()) {
          next = [
            ...next,
            { kind: "assistant", id: nextId(), text: tail, streaming: false },
          ];
        }
      }
      turnAccum.current = "";
      sawDeltaThisTurn.current = false;
      return next;
    });
  }, []);

  // ── Gateway lifecycle ─────────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    const gw = new GatewayClient();
    gwRef.current = gw;

    const offState = gw.onState((s) => {
      if (!mountedRef.current) return;
      setConnection(s);
      if (s === "open") {
        reconnectDelay.current = 1000;
        setConnectionError(null);
      }
      if ((s === "closed" || s === "error") && mountedRef.current) {
        // Schedule reconnect with capped backoff; re-resume happens below.
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(() => {
          void establish();
        }, reconnectDelay.current);
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 15000);
      }
    });

    const offs: Array<() => void> = [offState];
    const on = <P,>(type: string, h: (ev: GatewayEvent<P>) => void) => {
      offs.push(gw.on<P>(type, h));
    };

    const isMine = (ev: GatewayEvent<unknown>) =>
      !ev.session_id || ev.session_id === sessionIdRef.current;

    on<undefined>("message.start", (ev) => {
      if (!isMine(ev)) return;
      turnAccum.current = "";
      sawDeltaThisTurn.current = false;
      setRunning(true);
    });
    on<{ text?: string }>("message.delta", (ev) => {
      if (!isMine(ev)) return;
      appendAssistantDelta(ev.payload?.text ?? "");
    });
    on<{ text?: string; rendered?: string }>("message.complete", (ev) => {
      if (!isMine(ev)) return;
      finishTurn(ev.payload?.text || ev.payload?.rendered || "");
    });
    on<{ text?: string }>("reasoning.delta", (ev) => {
      if (!isMine(ev)) return;
      appendReasoning(ev.payload?.text ?? "", false);
    });
    on<{ text?: string }>("reasoning.available", (ev) => {
      if (!isMine(ev)) return;
      appendReasoning(ev.payload?.text ?? "", true);
    });
    on<{ kind?: string; text?: string }>("status.update", (ev) => {
      if (!isMine(ev)) return;
      setStatusLine(ev.payload?.text ?? null);
    });
    on<Record<string, unknown>>("session.info", (ev) => {
      if (!isMine(ev)) return;
      const next = infoFromPayload(ev.payload);
      setInfo((prev) => ({ ...prev, ...next }));
      if (next.running === false) {
        // Belt-and-suspenders turn end (e.g. after an interrupt).
        setRunning(false);
        setStatusLine(null);
      }
    });
    on<{ tool_id?: string; name?: string; args_text?: string }>(
      "tool.start",
      (ev) => {
        if (!isMine(ev) || !ev.payload?.tool_id) return;
        upsertTool(
          ev.payload.tool_id,
          {
            name: ev.payload.name,
            argsText: ev.payload.args_text,
            phase: "running",
          },
          true,
        );
      },
    );
    on<{ tool_id?: string; name?: string }>("tool.generating", (ev) => {
      if (!isMine(ev)) return;
      // Args still streaming — no stable tool_id in some builds; ignore if absent.
      if (ev.payload?.tool_id) {
        upsertTool(ev.payload.tool_id, { name: ev.payload.name, phase: "generating" }, true);
      }
    });
    on<{
      tool_id?: string;
      name?: string;
      result_text?: string;
      summary?: string;
      error?: string;
      duration_s?: number;
    }>("tool.complete", (ev) => {
      if (!isMine(ev) || !ev.payload?.tool_id) return;
      upsertTool(
        ev.payload.tool_id,
        {
          name: ev.payload.name,
          resultText: ev.payload.result_text,
          summary: ev.payload.summary,
          error: ev.payload.error,
          durationS: ev.payload.duration_s,
          phase: "complete",
          isError: Boolean(ev.payload.error),
        },
        true,
      );
    });
    on<{ command?: string; description?: string; allow_permanent?: boolean }>(
      "approval.request",
      (ev) => {
        if (!isMine(ev)) return;
        setPrompt({
          kind: "approval",
          command: ev.payload?.command,
          description: ev.payload?.description,
          allowPermanent: ev.payload?.allow_permanent,
        });
      },
    );
    on<{ question?: string; choices?: string[] | null; request_id?: string }>(
      "clarify.request",
      (ev) => {
        if (!isMine(ev)) return;
        setPrompt({
          kind: "clarify",
          question: ev.payload?.question,
          choices: ev.payload?.choices ?? null,
          requestId: ev.payload?.request_id,
        });
      },
    );
    on<{ request_id?: string }>("sudo.request", (ev) => {
      if (!isMine(ev)) return;
      setPrompt({ kind: "sudo", requestId: ev.payload?.request_id });
    });
    on<{ env_var?: string; prompt?: string; request_id?: string }>(
      "secret.request",
      (ev) => {
        if (!isMine(ev)) return;
        setPrompt({
          kind: "secret",
          envVar: ev.payload?.env_var,
          promptText: ev.payload?.prompt,
          requestId: ev.payload?.request_id,
        });
      },
    );
    // A pure message client has no terminal buffer — answer immediately so the
    // agent never blocks on it.
    on<{ request_id?: string }>("terminal.read.request", (ev) => {
      if (!isMine(ev) || !ev.payload?.request_id) return;
      void gw
        .request("terminal.read.respond", {
          request_id: ev.payload.request_id,
          text: "",
        })
        .catch(() => undefined);
    });
    on<{ message?: string }>("error", (ev) => {
      if (!isMine(ev)) return;
      setItems((prev) => [
        ...prev.map((it) =>
          it.kind === "assistant" && it.streaming
            ? { ...it, streaming: false, reasoningStreaming: false }
            : it,
        ),
        {
          kind: "system",
          id: nextId(),
          text: ev.payload?.message || "The agent hit an error.",
          tone: "error",
        },
      ]);
      setRunning(false);
      setStatusLine(null);
      setPrompt(null);
    });
    on<{ session_id?: string; title?: string }>("session.title", (ev) => {
      if (ev.payload?.title && ev.session_id === sessionIdRef.current) {
        setInfo((prev) => ({ ...prev, title: ev.payload?.title }));
      }
    });

    const establish = async () => {
      if (!mountedRef.current) return;
      try {
        await gw.connect();
      } catch (e) {
        if (mountedRef.current) {
          setConnectionError(e instanceof Error ? e.message : String(e));
        }
        return; // onState(closed/error) schedules the retry
      }
      if (!mountedRef.current) return;
      // (Re)attach to the session: explicit resume target, or the session we
      // already owned before a reconnect.
      const target = sessionIdRef.current ?? resumeId;
      if (target) {
        try {
          const res = await gw.request<SessionResumeResponse>("session.resume", {
            session_id: target,
          });
          if (!mountedRef.current) return;
          setSession(res.session_id);
          setItems(backfillToItems(res.messages ?? []));
          setInfo(infoFromPayload(res.info));
          setRunning(Boolean(res.running));
          setResumeFailed(null);
        } catch (e) {
          if (!mountedRef.current) return;
          setResumeFailed(e instanceof Error ? e.message : String(e));
        }
      }
    };

    void establish();

    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      offs.forEach((off) => off());
      gw.close();
      gwRef.current = null;
    };
    // resumeId identifies the thread this mount renders; a change remounts
    // via the page-level `key`, so deps stay empty on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Actions ─────────────────────────────────────────────────────────────────────────

  const send = useCallback(
    async (text: string) => {
      const gw = gwRef.current;
      const trimmed = text.trim();
      if (!gw || !trimmed) return;
      let sid = sessionIdRef.current;
      if (!sid) {
        const created = await gw.request<SessionCreateResponse>("session.create", {
          source: "web",
          cols: 120,
        });
        sid = created.session_id;
        setSession(sid);
        setInfo((prev) => ({ ...prev, ...infoFromPayload(created.info) }));
      }
      setItems((prev) => [...prev, { kind: "user", id: nextId(), text: trimmed }]);
      setRunning(true);
      // Turn completion arrives via events; generous ack timeout.
      await gw.request("prompt.submit", { session_id: sid, text: trimmed }, 1_800_000);
    },
    [setSession],
  );

  const interrupt = useCallback(async () => {
    const gw = gwRef.current;
    const sid = sessionIdRef.current;
    if (!gw || !sid) return;
    await gw.request("session.interrupt", { session_id: sid });
    setRunning(false);
    setStatusLine(null);
  }, []);

  const respondApproval = useCallback(
    async (choice: "once" | "session" | "always" | "deny") => {
      const gw = gwRef.current;
      const sid = sessionIdRef.current;
      setPrompt(null);
      if (!gw || !sid) return;
      await gw.request("approval.respond", { session_id: sid, choice });
    },
    [],
  );

  const respondClarify = useCallback(async (answer: string) => {
    const gw = gwRef.current;
    const sid = sessionIdRef.current;
    setPrompt(null);
    if (!gw || !sid) return;
    await gw.request("clarify.respond", { session_id: sid, answer });
  }, []);

  const respondSecret = useCallback(async (value: string) => {
    const gw = gwRef.current;
    const sid = sessionIdRef.current;
    const kind = prompt?.kind;
    setPrompt(null);
    if (!gw || !sid) return;
    if (kind === "sudo") {
      await gw.request("sudo.respond", { session_id: sid, password: value });
    } else {
      await gw.request("secret.respond", { session_id: sid, value });
    }
  }, [prompt?.kind]);

  return useMemo(
    () => ({
      items,
      connection,
      connectionError,
      running,
      statusLine,
      info,
      prompt,
      sessionId,
      resumeFailed,
      send,
      interrupt,
      respondApproval,
      respondClarify,
      respondSecret,
    }),
    [
      items,
      connection,
      connectionError,
      running,
      statusLine,
      info,
      prompt,
      sessionId,
      resumeFailed,
      send,
      interrupt,
      respondApproval,
      respondClarify,
      respondSecret,
    ],
  );
}
