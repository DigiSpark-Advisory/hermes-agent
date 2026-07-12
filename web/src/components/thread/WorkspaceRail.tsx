/**
 * WorkspaceRail — v1.3 third column of the chat surface (wireframe-approved
 * 2026-07-12): a collapsible right-hand rail on xl+ screens.
 *
 *   Vault tab   — live view of /opt/data/vault/deliverables: artifacts
 *                 grouped as source + rendered outputs with lifecycle
 *                 badges (RENDERING / RENDERED / ERROR via _render/errors),
 *                 format chips, click-to-download, and the renderer
 *                 heartbeat from _render/status.md. Polls every 20s while
 *                 open — rides the existing files API, no new endpoints.
 *   Session tab — the live context card: model/provider/effort, running +
 *                 connection state, cwd, session id (copy), toolset list,
 *                 and a jump to the Sessions power page.
 *
 * The Scheduled card probes a few plausible cron API method names and
 * renders ONLY if one returns a recognisable job list. LESSON (v1.3.1,
 * React #31 crash on first deploy): cron job fields — notably `schedule`,
 * which is a {kind, expr, display} object — must NEVER be rendered
 * directly; everything passes through string extractors below.
 */

import { Spinner } from "@nous-research/ui/ui/components/spinner";
import {
  AlertCircle,
  Check,
  ClipboardCopy,
  ExternalLink,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "@/lib/api";
import type { ManagedFileEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ThreadSessionInfo } from "@/hooks/useChatThread";
import type { ConnectionState } from "@/lib/gatewayClient";

const VAULT_DIR = "/opt/data/vault/deliverables";
const ERRORS_DIR = "/opt/data/vault/_render/errors";
const STATUS_FILE = "/opt/data/vault/_render/status.md";
const POLL_MS = 20_000;
const MAX_ARTIFACTS = 12;

interface Artifact {
  stem: string;
  sourceName: string;
  sourcePath: string;
  sourceMtime: number;
  outputs: { ext: string; path: string; name: string }[];
  expectedExts: string[];
  state: "rendering" | "rendered" | "error";
}

function decodeDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return "";
  try {
    return atob(dataUrl.slice(comma + 1));
  } catch {
    return "";
  }
}

function relTime(unixSeconds: number): string {
  const d = Date.now() / 1000 - unixSeconds;
  if (d < 90) return `${Math.max(1, Math.round(d))}s ago`;
  if (d < 5400) return `${Math.round(d / 60)}m ago`;
  if (d < 86400 * 2) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

/** Group a flat deliverables listing into artifacts (source + outputs). */
function groupArtifacts(
  entries: ManagedFileEntry[],
  errorNames: Set<string>,
): Artifact[] {
  const files = entries.filter((e) => !e.is_directory);
  const byName = new Map(files.map((f) => [f.name, f]));
  const arts: Artifact[] = [];
  for (const f of files) {
    let stem: string | null = null;
    let expected: string[] = [];
    if (f.name.endsWith(".deck.md")) {
      stem = f.name.slice(0, -".deck.md".length);
      expected = ["pptx"];
    } else if (f.name.endsWith(".sheet.json")) {
      stem = f.name.slice(0, -".sheet.json".length);
      expected = ["xlsx"];
    } else if (f.name.endsWith(".md")) {
      stem = f.name.slice(0, -".md".length);
      expected = ["pdf"];
    }
    if (stem === null) continue; // outputs are attached below
    const outputs: Artifact["outputs"] = [];
    for (const ext of ["pdf", "docx", "pptx", "xlsx"]) {
      const candidate = `${stem}.${ext}`;
      const hit = byName.get(candidate);
      if (hit) outputs.push({ ext, path: hit.path, name: hit.name });
    }
    const hasError = errorNames.has(`${f.name}.txt`);
    const missingExpected = expected.some(
      (ext) => !outputs.some((o) => o.ext === ext),
    );
    arts.push({
      stem,
      sourceName: f.name,
      sourcePath: f.path,
      sourceMtime: f.mtime,
      outputs,
      expectedExts: expected,
      state: hasError ? "error" : missingExpected ? "rendering" : "rendered",
    });
  }
  arts.sort((a, b) => b.sourceMtime - a.sourceMtime);
  return arts.slice(0, MAX_ARTIFACTS);
}

function downloadDataUrl(dataUrl: string, name: string) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = name || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

type CronJobLike = Record<string, unknown>;

/** Only ever returns a string — the React #31 guard. */
function stringOr(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/** Schedule may be a string OR an object like {kind, expr, display}. */
function scheduleLabel(job: CronJobLike): string {
  for (const field of ["schedule", "cron"]) {
    const s = job[field];
    if (typeof s === "string") return s;
    if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      for (const k of ["display", "expr", "cron", "expression"]) {
        if (typeof o[k] === "string") return o[k] as string;
      }
    }
  }
  return "";
}

function jobLabel(job: CronJobLike): string {
  return stringOr(job.name) || stringOr(job.id) || "Scheduled job";
}

/** Best-effort cron probe — renders nothing if no known method matches. */
async function probeCronJobs(): Promise<CronJobLike[] | null> {
  const a = api as unknown as Record<string, unknown>;
  for (const method of ["listCronJobs", "getCronJobs", "listCron", "getCron"]) {
    const fn = a[method];
    if (typeof fn !== "function") continue;
    try {
      const res = await (fn as () => Promise<unknown>)();
      const jobs =
        Array.isArray(res)
          ? res
          : res && typeof res === "object" && Array.isArray((res as { jobs?: unknown[] }).jobs)
            ? (res as { jobs: unknown[] }).jobs
            : null;
      if (jobs && jobs.every((j) => j && typeof j === "object")) {
        return jobs as CronJobLike[];
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

const STATE_BADGE: Record<Artifact["state"], { label: string; cls: string }> = {
  rendering: { label: "RENDERING", cls: "text-[var(--ds-accent)] bg-[color-mix(in_srgb,var(--ds-accent)_12%,transparent)]" },
  rendered: { label: "RENDERED", cls: "text-[var(--ds-green)] bg-[color-mix(in_srgb,var(--ds-green)_12%,transparent)]" },
  error: { label: "ERROR", cls: "text-destructive bg-destructive/10" },
};

export function WorkspaceRail({
  open,
  onToggle,
  info,
  sessionId,
  connection,
  running,
}: {
  open: boolean;
  onToggle(): void;
  info: ThreadSessionInfo;
  sessionId: string | null;
  connection: ConnectionState;
  running: boolean;
}) {
  const [tab, setTab] = useState<"vault" | "session">("vault");
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [heartbeat, setHeartbeat] = useState<string | null>(null);
  const [cronJobs, setCronJobs] = useState<CronJobLike[] | null>(null);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadVault = useCallback(async () => {
    try {
      const listing = await api.listFiles(VAULT_DIR);
      let errorNames = new Set<string>();
      try {
        const errs = await api.listFiles(ERRORS_DIR);
        errorNames = new Set(errs.entries.filter((e) => !e.is_directory).map((e) => e.name));
      } catch {
        /* no errors dir yet — fine */
      }
      setArtifacts(groupArtifacts(listing.entries, errorNames));
      setVaultError(null);
      try {
        const status = await api.readFile(STATUS_FILE);
        const text = decodeDataUrl(status.data_url);
        const m = text.match(/last-run:\s*(\S+)/);
        if (m) {
          const t = Date.parse(m[1]) / 1000;
          setHeartbeat(Number.isFinite(t) ? relTime(t) : null);
        }
      } catch {
        setHeartbeat(null);
      }
    } catch (e) {
      setVaultError(String(e));
    }
  }, []);

  // Poll while open; one-shot cron probe.
  useEffect(() => {
    if (!open) return;
    void loadVault();
    void probeCronJobs().then(setCronJobs);
    timerRef.current = setInterval(() => void loadVault(), POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [open, loadVault]);

  const copyId = useCallback(() => {
    // navigator.clipboard is undefined on non-secure origins (the LAN
    // dashboard is plain HTTP) — guard, don't throw.
    if (!sessionId || !navigator.clipboard) return;
    void navigator.clipboard.writeText(sessionId).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  }, [sessionId]);

  const digestJob = useMemo(() => {
    if (!cronJobs?.length) return null;
    return (
      cronJobs.find((j) => jobLabel(j).toLowerCase().includes("digest")) ??
      cronJobs[0]
    );
  }, [cronJobs]);

  if (!open) {
    return (
      <div className="hidden w-9 shrink-0 flex-col items-center border-l border-current/10 pt-3 xl:flex">
        <button
          type="button"
          onClick={onToggle}
          aria-label="Open workspace rail"
          title="Open workspace"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-text-tertiary hover:bg-midground/5 hover:text-text-secondary"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      </div>
    );
  }

  const scheduleText = digestJob ? scheduleLabel(digestJob) : "";
  const lastStatusText = digestJob ? stringOr(digestJob.last_status) : "";
  const jobEnabled = digestJob ? digestJob.enabled !== false : true;

  return (
    <aside
      className="hidden w-72 shrink-0 flex-col border-l border-current/10 xl:flex"
      aria-label="Workspace"
    >
      <div className="flex shrink-0 items-center border-b border-current/10">
        {(
          [
            ["vault", "Vault"],
            ["session", "Session"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "flex-1 cursor-pointer border-0 bg-transparent px-2 py-2.5",
              "text-center font-sans text-[0.6875rem] font-semibold uppercase tracking-[0.06em]",
              tab === key
                ? "text-[var(--ds-accent)] shadow-[inset_0_-2px_0_var(--ds-accent)]"
                : "text-text-tertiary hover:text-text-secondary",
            )}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse workspace rail"
          title="Collapse"
          className="mx-1 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-text-tertiary hover:bg-midground/5 hover:text-text-secondary"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      {tab === "vault" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            <div className="px-0.5 font-sans text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
              Deliverables
            </div>
            {vaultError && (
              <div className="rounded border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[0.6875rem] text-destructive">
                {vaultError}
              </div>
            )}
            {artifacts === null && !vaultError && (
              <div className="flex items-center gap-2 px-1 py-4 text-xs text-text-tertiary">
                <Spinner aria-label="loading" /> Loading vault…
              </div>
            )}
            {artifacts?.length === 0 && (
              <div className="px-1 py-4 text-center text-xs text-text-tertiary">
                No deliverables yet — ask the analyst to stage one.
              </div>
            )}
            {artifacts?.map((a) => {
              const badge = STATE_BADGE[a.state];
              const primary = a.outputs[0];
              return (
                <button
                  key={a.sourcePath}
                  type="button"
                  onClick={() => {
                    const target = primary ?? { path: a.sourcePath, name: a.sourceName, ext: "" };
                    void api
                      .readFile(target.path)
                      .then((f) => downloadDataUrl(f.data_url, f.name))
                      .catch(() => undefined);
                  }}
                  title={primary ? `Download ${primary.name}` : `Download ${a.sourceName}`}
                  className={cn(
                    "block w-full cursor-pointer rounded-lg border border-current/10 bg-card",
                    "px-2.5 py-2 text-left shadow-sm hover:bg-midground/4",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-sans text-xs font-semibold">
                      {a.stem}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-1.5 py-0.5 text-[0.5625rem] font-bold tracking-[0.04em]",
                        badge.cls,
                      )}
                    >
                      {badge.label}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[0.625rem] text-text-tertiary">
                    {relTime(a.sourceMtime)}
                  </span>
                  <span className="mt-1.5 flex gap-1">
                    <span className="rounded border border-current/10 px-1 py-px text-[0.5625rem] font-semibold text-text-secondary">
                      SRC
                    </span>
                    {a.expectedExts.map((ext) => {
                      const present = a.outputs.some((o) => o.ext === ext);
                      return (
                        <span
                          key={ext}
                          className={cn(
                            "rounded border border-current/10 px-1 py-px text-[0.5625rem] font-semibold uppercase",
                            present ? "text-text-secondary" : "text-text-tertiary opacity-40",
                          )}
                        >
                          {ext}
                        </span>
                      );
                    })}
                    {a.outputs
                      .filter((o) => !a.expectedExts.includes(o.ext))
                      .map((o) => (
                        <span
                          key={o.ext}
                          className="rounded border border-current/10 px-1 py-px text-[0.5625rem] font-semibold uppercase text-text-secondary"
                        >
                          {o.ext}
                        </span>
                      ))}
                  </span>
                </button>
              );
            })}

            {digestJob && (
              <>
                <div className="px-0.5 pt-2 font-sans text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
                  Scheduled
                </div>
                <div className="rounded-lg border border-current/10 bg-card px-2.5 py-2 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        jobEnabled ? "bg-[var(--ds-green)]" : "bg-muted-foreground",
                      )}
                    />
                    <span className="truncate font-semibold">{jobLabel(digestJob)}</span>
                  </div>
                  {(scheduleText || lastStatusText) && (
                    <div className="mt-0.5 pl-3 text-[0.625rem] text-text-tertiary">
                      {scheduleText && <span className="font-mono-ui">{scheduleText}</span>}
                      {scheduleText && lastStatusText && <span> · </span>}
                      {lastStatusText && <span>last: {lastStatusText}</span>}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center justify-between border-t border-current/10 px-3 py-2 text-[0.625rem] text-text-tertiary">
            <span className="flex items-center gap-1">
              {heartbeat ? (
                <>
                  <Check className="h-3 w-3 text-[var(--ds-green)]" /> render {heartbeat}
                </>
              ) : (
                <>
                  <AlertCircle className="h-3 w-3 text-warning" /> render status unknown
                </>
              )}
            </span>
            <span>vault · 20s poll</span>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
          <div>
            <div className="mb-1 font-sans text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
              Model
            </div>
            <div className="rounded-lg border border-current/10 bg-card px-2.5 py-2 shadow-sm">
              <div className="truncate font-mono-ui">{info.model ?? "—"}</div>
              <div className="mt-0.5 text-[0.625rem] text-text-tertiary">
                {info.provider ?? "provider —"}
                {info.reasoningEffort ? ` · effort: ${info.reasoningEffort}` : ""}
              </div>
            </div>
          </div>

          <div>
            <div className="mb-1 font-sans text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
              State
            </div>
            <div className="rounded-lg border border-current/10 bg-card px-2.5 py-2 shadow-sm">
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    connection === "open" ? "bg-[var(--ds-green)]" : "bg-warning",
                  )}
                />
                <span>{connection === "open" ? "connected" : connection}</span>
                <span className="text-text-tertiary">·</span>
                <span>{running ? "working…" : "idle"}</span>
              </div>
              {info.cwd && (
                <div className="mt-1 truncate font-mono-ui text-[0.625rem] text-text-tertiary" title={info.cwd}>
                  {info.cwd}
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="mb-1 font-sans text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
              Session
            </div>
            <div className="rounded-lg border border-current/10 bg-card px-2.5 py-2 shadow-sm">
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-mono-ui text-[0.6875rem]" title={sessionId ?? undefined}>
                  {sessionId ?? "not started — send a message"}
                </span>
                {sessionId && Boolean(navigator.clipboard) && (
                  <button
                    type="button"
                    onClick={copyId}
                    aria-label="Copy session id"
                    title={copied ? "Copied" : "Copy session id"}
                    className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-text-tertiary hover:text-text-secondary"
                  >
                    {copied ? <Check className="h-3 w-3 text-[var(--ds-green)]" /> : <ClipboardCopy className="h-3 w-3" />}
                  </button>
                )}
              </div>
              {info.title && (
                <div className="mt-0.5 truncate text-[0.625rem] text-text-tertiary">{info.title}</div>
              )}
              <Link
                to="/sessions"
                className="mt-1.5 inline-flex items-center gap-1 text-[0.625rem] text-[var(--ds-accent)] hover:underline"
              >
                Manage on Sessions page <ExternalLink className="h-2.5 w-2.5" />
              </Link>
            </div>
          </div>

          <div>
            <div className="mb-1 font-sans text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
              Tools{info.toolCount != null ? ` (${info.toolCount})` : ""}
            </div>
            <div className="rounded-lg border border-current/10 bg-card px-2.5 py-2 shadow-sm">
              {info.toolNames?.length ? (
                <div className="flex flex-wrap gap-1">
                  {info.toolNames.map((n) => (
                    <span
                      key={n}
                      className="rounded border border-current/10 px-1 py-px font-mono-ui text-[0.5625rem] text-text-secondary"
                    >
                      {n}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-[0.625rem] text-text-tertiary">
                  Tool list arrives with the first session.info event.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
