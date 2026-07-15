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
 * v1.3.2 (vault v2 folder support, wireframe-approved 2026-07-12 evening):
 * the vault is now class folders + year archive
 * (deliverables/<class>/YYYY/…, client/<slug>/…), so the flat listing is
 * replaced by a BOUNDED two-level walk — class dirs, then at most the 3
 * most recent subdirs per class (year folders / client slugs). Artifacts
 * render under collapsible class groups (collapse state persisted per
 * browser), newest-first within a group, groups ordered by their newest
 * artifact, max 8 cards per group. Year folders are flattened out of the
 * display (the date is in the filename); client work groups per slug.
 * Stray files at the deliverables root land in an "Other" group.
 *
 * v1.3.3 (project groups, wireframe-approved 2026-07-12 night): non-year
 * subdirs (anything not matching ^\d{4}$) become their OWN groups labelled
 * "<Class> · <slug>" — so research/<project-slug>/ and client/<slug>/ render
 * as RESEARCH · PRIME-INTELLECT, CLIENT · ACME, matching the project-grouped
 * vault convention; year dirs keep flattening into the plain class group
 * (the unfiled fallback). FIX: v1.3.2 picked subdirs by NAME desc — right
 * for years, wrong for project slugs (reverse-alphabetical dropped active
 * projects once a class had >3 subdirs); now mtime desc (name desc as
 * tiebreak/fallback) with the cap raised to 6.
 *
 * v1.3.4 (pin/hide, 2026-07-14): as projects accumulate the rail needs
 * curation, so every group header gains two controls — PIN (pinned groups
 * sort first, and pinned project subdirs are always walked without
 * consuming a MAX_SUBDIRS_PER_CLASS slot) and HIDE (the group leaves the
 * rail; the cap refills from the remaining subdirs; hidden subdirs are not
 * even fetched). Hidden groups collect in a "Hidden (n)" footer row for
 * one-click unhide — this is DISPLAY-ONLY state: nothing in the vault
 * moves, renames, or deletes. Pin/hide persist per browser in
 * localStorage alongside the existing collapse state. Year dirs have no
 * per-year controls — they ride the plain class group (the unfiled
 * fallback) and are now always flattened rather than competing for cap
 * slots.
 *
 * Also in the v1.3.4 batch: the Scheduled card lists ALL cron jobs
 * (digest + triage + whatever lands next), newest API order, capped at
 * MAX_CRON_CARDS — the previous card showed only the first digest match,
 * which went stale the moment a second job existed.
 *
 * v1.3.5 (archive/trash, 2026-07-14 night): every artifact card gains an
 * ARCHIVE control (two-step inline confirm — no browser dialogs) that
 * soft-moves the source + all rendered outputs to
 * /opt/data/vault/_trash/deliverables/<original-relative-path> via the
 * EXISTING gateway files API (readFile -> upload-stream -> delete;
 * COPY-THEN-DELETE order so a mid-move failure can duplicate bytes but
 * never lose them), then clears the matching _render/errors record. A
 * "Trash (n)" footer lists archived files with one-click RESTORE (the
 * reverse move). There is NO hard delete in this UI — emptying _trash/
 * stays a board-side human action. _trash/ is excluded from the OneDrive
 * mirror (compose --exclude), so archiving also drops the artifact from
 * OneDrive within a sync pass. Governance note: these are DASHBOARD-USER
 * actions riding endpoints that already existed — the agent gains no
 * capability, and the standing "agent never deletes vault files"
 * invariant is untouched.
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
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  Eye,
  EyeOff,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "@/lib/api";
import type { ManagedFileEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ThreadSessionInfo } from "@/hooks/useChatThread";
import type { ConnectionState } from "@/lib/gatewayClient";

const VAULT_ROOT = "/opt/data/vault";
const VAULT_DIR = `${VAULT_ROOT}/deliverables`;
const TRASH_DIR = `${VAULT_ROOT}/_trash`;
const ERRORS_DIR = `${VAULT_ROOT}/_render/errors`;
const STATUS_FILE = `${VAULT_ROOT}/_render/status.md`;
const POLL_MS = 20_000;
const MAX_PER_GROUP = 8;
const MAX_CRON_CARDS = 6;
const MAX_TRASH_ROWS = 30;
const MAX_SUBDIRS_PER_CLASS = 6;
const COLLAPSE_KEY = "ds.rail.vault.collapsed";
const PIN_KEY = "ds.rail.vault.pinned";
const HIDE_KEY = "ds.rail.vault.hidden";
const YEAR_RE = /^\d{4}$/;

const CLASS_LABELS: Record<string, string> = {
  "news-digest": "News digest",
  triage: "Triage",
  research: "Research",
  ops: "Ops",
  client: "Client",
};

interface Artifact {
  stem: string;
  sourceName: string;
  sourcePath: string;
  sourceMtime: number;
  outputs: { ext: string; path: string; name: string }[];
  expectedExts: string[];
  state: "rendering" | "rendered" | "error";
}

interface VaultGroup {
  key: string; // "news-digest" | "client/acme-defense" | "other" | …
  label: string;
  artifacts: Artifact[];
  hasError: boolean;
}

/** A hidden group we know exists but deliberately did not fetch/render. */
interface HiddenGroupRef {
  key: string;
  label: string;
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

/** Group a flat file listing into artifacts (source + outputs). */
function groupArtifacts(
  entries: ManagedFileEntry[],
  errorNames: Set<string>,
  cap = MAX_PER_GROUP,
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
  return arts.slice(0, cap);
}

/** listFiles that swallows errors — used for OPTIONAL subdirectories only. */
async function listDirSafe(path: string): Promise<ManagedFileEntry[]> {
  try {
    const res = await api.listFiles(path);
    return res.entries;
  } catch {
    return [];
  }
}

function makeGroup(
  key: string,
  label: string,
  files: ManagedFileEntry[],
  errorNames: Set<string>,
): VaultGroup {
  const artifacts = groupArtifacts(files, errorNames);
  return {
    key,
    label,
    artifacts,
    hasError: artifacts.some((a) => a.state === "error"),
  };
}

/**
 * Bounded walk of the vault v2 tree: class dirs at the root, then their
 * subdirs. Year dirs (^\d{4}$, the unfiled fallback) always flatten into
 * the plain class group; every other subdir is a project/client slug and
 * becomes its own "<Class> · <slug>" group, selected newest-activity-first
 * up to MAX_SUBDIRS_PER_CLASS. v1.3.4: pinned slugs are always selected
 * without consuming a cap slot; hidden slugs (and hidden class/other
 * groups) are skipped without fetching and reported back as HiddenGroupRef
 * so the footer can offer unhide. Never throws — subdir listing failures
 * degrade to an empty group.
 */
async function gatherGroups(
  rootEntries: ManagedFileEntry[],
  errorNames: Set<string>,
  pinned: Set<string>,
  hidden: Set<string>,
): Promise<{ groups: VaultGroup[]; hiddenGroups: HiddenGroupRef[] }> {
  const groups: VaultGroup[] = [];
  const hiddenGroups: HiddenGroupRef[] = [];
  const rootFiles = rootEntries.filter((e) => !e.is_directory);
  if (rootFiles.length) {
    if (hidden.has("other")) {
      hiddenGroups.push({ key: "other", label: "Other" });
    } else {
      groups.push(makeGroup("other", "Other", rootFiles, errorNames));
    }
  }
  const classDirs = rootEntries.filter((e) => e.is_directory);
  for (const dir of classDirs) {
    const entries = await listDirSafe(`${VAULT_DIR}/${dir.name}`);
    const files = entries.filter((e) => !e.is_directory);
    const label = CLASS_LABELS[dir.name] ?? dir.name;
    const classHidden = hidden.has(dir.name);
    // Newest-activity subdirs first (v1.3.3): mtime desc, name desc as the
    // tiebreak AND the fallback when the files API omits dir mtimes.
    const allSubdirs = entries
      .filter((e) => e.is_directory)
      .sort(
        (a, b) =>
          ((b.mtime ?? 0) - (a.mtime ?? 0)) || b.name.localeCompare(a.name),
      );
    // v1.3.4 selection: hidden slugs drop out (the cap refills from the
    // rest), pinned slugs are always in and free; years always flatten.
    const subdirs: ManagedFileEntry[] = [];
    let unpinnedCount = 0;
    let hasYearDir = false;
    for (const sub of allSubdirs) {
      if (YEAR_RE.test(sub.name)) {
        hasYearDir = true;
        subdirs.push(sub);
        continue;
      }
      const key = `${dir.name}/${sub.name}`;
      if (hidden.has(key)) {
        hiddenGroups.push({ key, label: `${label} · ${sub.name}` });
        continue;
      }
      if (pinned.has(key)) {
        subdirs.push(sub);
      } else if (unpinnedCount < MAX_SUBDIRS_PER_CLASS) {
        subdirs.push(sub);
        unpinnedCount++;
      }
    }
    // Year dirs flatten into the plain class group (unfiled fallback);
    // every other selected subdir gets its OWN group.
    let flat = files;
    for (const sub of subdirs) {
      if (YEAR_RE.test(sub.name)) {
        if (classHidden) continue; // hidden class — skip the fetch entirely
        const subFiles = (
          await listDirSafe(`${VAULT_DIR}/${dir.name}/${sub.name}`)
        ).filter((e) => !e.is_directory);
        flat = flat.concat(subFiles);
      } else {
        const subFiles = (
          await listDirSafe(`${VAULT_DIR}/${dir.name}/${sub.name}`)
        ).filter((e) => !e.is_directory);
        if (subFiles.length) {
          groups.push(
            makeGroup(
              `${dir.name}/${sub.name}`,
              `${label} · ${sub.name}`,
              subFiles,
              errorNames,
            ),
          );
        }
      }
    }
    if (classHidden) {
      if (files.length || hasYearDir) {
        hiddenGroups.push({ key: dir.name, label });
      }
    } else if (flat.length) {
      groups.push(makeGroup(dir.name, label, flat, errorNames));
    }
  }
  // Pinned groups first, then by newest artifact (v1.3.4).
  groups.sort((a, b) => {
    const pinDelta = (pinned.has(b.key) ? 1 : 0) - (pinned.has(a.key) ? 1 : 0);
    if (pinDelta) return pinDelta;
    return (
      (b.artifacts[0]?.sourceMtime ?? 0) - (a.artifacts[0]?.sourceMtime ?? 0)
    );
  });
  return {
    groups: groups.filter((g) => g.artifacts.length > 0),
    hiddenGroups,
  };
}

function loadKeySet(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveKeySet(storageKey: string, set: Set<string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...set]));
  } catch {
    /* storage unavailable — state just won't persist */
  }
}

// ── Archive / trash (v1.3.5) ────────────────────────────────────────

/** One file sitting in _trash/, with enough context to restore it. */
interface TrashEntry {
  name: string;
  path: string; // full path under TRASH_DIR
  relDir: string; // dir relative to VAULT_ROOT, e.g. "deliverables/research/peraton"
}

async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || "application/octet-stream" });
}

/**
 * Move one file via the files API: read -> mkdir -> upload copy -> delete
 * original. COPY-THEN-DELETE: any failure before the final step leaves the
 * original in place (worst case a duplicate copy) — bytes are never lost.
 */
async function moveFile(srcPath: string, destDir: string, name: string): Promise<void> {
  const f = await api.readFile(srcPath);
  const file = await dataUrlToFile(f.data_url, name);
  await api.createDirectory(destDir).catch(() => undefined); // may already exist
  await api.uploadFile(`${destDir}/${name}`, file, true);
  await api.deleteFile(srcPath);
}

/** Bounded 3-level walk of _trash/deliverables (class -> subdir -> files). */
async function gatherTrash(): Promise<TrashEntry[]> {
  const out: TrashEntry[] = [];
  const take = (entries: ManagedFileEntry[], relDir: string) => {
    for (const e of entries) {
      if (!e.is_directory) out.push({ name: e.name, path: e.path, relDir });
    }
  };
  const root = await listDirSafe(`${TRASH_DIR}/deliverables`);
  take(root, "deliverables");
  for (const d1 of root.filter((e) => e.is_directory)) {
    const l1 = await listDirSafe(`${TRASH_DIR}/deliverables/${d1.name}`);
    take(l1, `deliverables/${d1.name}`);
    for (const d2 of l1.filter((e) => e.is_directory)) {
      const l2 = await listDirSafe(`${TRASH_DIR}/deliverables/${d1.name}/${d2.name}`);
      take(l2, `deliverables/${d1.name}/${d2.name}`);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out.slice(0, MAX_TRASH_ROWS);
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
  const [groups, setGroups] = useState<VaultGroup[] | null>(null);
  const [hiddenGroups, setHiddenGroups] = useState<HiddenGroupRef[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadKeySet(COLLAPSE_KEY));
  const [pinned, setPinned] = useState<Set<string>>(() => loadKeySet(PIN_KEY));
  const [hidden, setHidden] = useState<Set<string>>(() => loadKeySet(HIDE_KEY));
  const [showHidden, setShowHidden] = useState(false);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [heartbeat, setHeartbeat] = useState<string | null>(null);
  const [cronJobs, setCronJobs] = useState<CronJobLike[] | null>(null);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveKeySet(COLLAPSE_KEY, next);
      return next;
    });
  }, []);

  const togglePin = useCallback((key: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveKeySet(PIN_KEY, next);
      return next;
    });
  }, []);

  const toggleHide = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveKeySet(HIDE_KEY, next);
      return next;
    });
  }, []);

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
      const res = await gatherGroups(listing.entries, errorNames, pinned, hidden);
      setGroups(res.groups);
      setHiddenGroups(res.hiddenGroups);
      setTrash(await gatherTrash());
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
  }, [pinned, hidden]);

  /** Archive an artifact: soft-move source + every output into _trash/,
   * preserving the deliverables-relative path, then clear its render-error
   * record. Sequential, copy-then-delete per file. */
  const archiveArtifact = useCallback(
    async (a: Artifact) => {
      setBusyPath(a.sourcePath);
      try {
        const targets = [
          { path: a.sourcePath, name: a.sourceName },
          ...a.outputs.map((o) => ({ path: o.path, name: o.name })),
        ];
        for (const t of targets) {
          const rel = t.path.startsWith(`${VAULT_DIR}/`)
            ? t.path.slice(VAULT_DIR.length + 1)
            : t.name;
          const relDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
          const destDir = relDir
            ? `${TRASH_DIR}/deliverables/${relDir}`
            : `${TRASH_DIR}/deliverables`;
          await moveFile(t.path, destDir, t.name);
        }
        await api.deleteFile(`${ERRORS_DIR}/${a.sourceName}.txt`).catch(() => undefined);
      } catch (e) {
        setVaultError(`Archive failed (nothing is lost — copy-then-delete): ${String(e)}`);
      } finally {
        setBusyPath(null);
        setConfirmKey(null);
        void loadVault();
      }
    },
    [loadVault],
  );

  /** Restore one file from _trash/ back to its original vault location. */
  const restoreEntry = useCallback(
    async (t: TrashEntry) => {
      setBusyPath(t.path);
      try {
        await moveFile(t.path, `${VAULT_ROOT}/${t.relDir}`, t.name);
      } catch (e) {
        setVaultError(`Restore failed (nothing is lost — copy-then-delete): ${String(e)}`);
      } finally {
        setBusyPath(null);
        void loadVault();
      }
    },
    [loadVault],
  );

  // Poll while open; one-shot cron probe. Pin/hide toggles re-create
  // loadVault, which re-runs this effect — an immediate refresh so the cap
  // refills without waiting for the next poll tick.
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
            {groups === null && !vaultError && (
              <div className="flex items-center gap-2 px-1 py-4 text-xs text-text-tertiary">
                <Spinner aria-label="loading" /> Loading vault…
              </div>
            )}
            {groups?.length === 0 && hiddenGroups.length === 0 && (
              <div className="px-1 py-4 text-center text-xs text-text-tertiary">
                No deliverables yet — ask the analyst to stage one.
              </div>
            )}
            {groups?.map((g) => {
              const isCollapsed = collapsed.has(g.key);
              const isPinned = pinned.has(g.key);
              return (
                <div key={g.key}>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.key)}
                      aria-expanded={!isCollapsed}
                      title={isCollapsed ? `Expand ${g.label}` : `Collapse ${g.label}`}
                      className={cn(
                        "flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded border-0 bg-transparent",
                        "px-0.5 py-1 text-left font-sans text-[0.625rem] font-semibold uppercase",
                        "tracking-[0.08em] text-text-secondary hover:text-text-primary",
                      )}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      )}
                      <span className="min-w-0 truncate">{g.label}</span>
                      <span className="text-text-tertiary">({g.artifacts.length})</span>
                      {g.hasError && (
                        <AlertCircle
                          className="h-3 w-3 shrink-0 text-destructive"
                          aria-label="A file in this group has a render error"
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => togglePin(g.key)}
                      aria-label={isPinned ? `Unpin ${g.label}` : `Pin ${g.label}`}
                      aria-pressed={isPinned}
                      title={isPinned ? "Unpin" : "Pin (always shown, sorts first)"}
                      className={cn(
                        "flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent",
                        isPinned
                          ? "text-[var(--ds-accent)]"
                          : "text-text-tertiary/50 hover:text-text-secondary",
                      )}
                    >
                      <Pin className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleHide(g.key)}
                      aria-label={`Hide ${g.label}`}
                      title="Hide from rail (files stay in the vault)"
                      className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-text-tertiary/50 hover:text-text-secondary"
                    >
                      <EyeOff className="h-3 w-3" />
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div className="space-y-2 pt-1">
                      {g.artifacts.map((a) => {
                        const badge = STATE_BADGE[a.state];
                        const primary = a.outputs[0];
                        const download = () => {
                          const target =
                            primary ?? { path: a.sourcePath, name: a.sourceName, ext: "" };
                          void api
                            .readFile(target.path)
                            .then((f) => downloadDataUrl(f.data_url, f.name))
                            .catch(() => undefined);
                        };
                        return (
                          // div-as-button so the archive controls can be REAL
                          // buttons inside (nested <button> is invalid HTML).
                          <div
                            key={a.sourcePath}
                            role="button"
                            tabIndex={0}
                            onClick={download}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") download();
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
                              <span className="ml-auto flex items-center gap-0.5">
                                {busyPath === a.sourcePath ? (
                                  <Spinner aria-label="archiving" />
                                ) : confirmKey === a.sourcePath ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void archiveArtifact(a);
                                      }}
                                      aria-label={`Confirm archive of ${a.stem}`}
                                      title="Confirm — move to trash (restorable)"
                                      className="flex h-5 w-5 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-destructive hover:bg-destructive/10"
                                    >
                                      <Check className="h-3 w-3" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setConfirmKey(null);
                                      }}
                                      aria-label="Cancel archive"
                                      title="Cancel"
                                      className="flex h-5 w-5 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-text-tertiary hover:text-text-secondary"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConfirmKey(a.sourcePath);
                                    }}
                                    aria-label={`Archive ${a.stem}`}
                                    title="Archive to trash (restorable; no hard delete)"
                                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-text-tertiary/50 hover:text-text-secondary"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                )}
                              </span>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {hiddenGroups.length > 0 && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowHidden((v) => !v)}
                  aria-expanded={showHidden}
                  title={showHidden ? "Collapse hidden groups" : "Show hidden groups"}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-1 rounded border-0 bg-transparent",
                    "px-0.5 py-1 text-left font-sans text-[0.625rem] font-semibold uppercase",
                    "tracking-[0.08em] text-text-tertiary hover:text-text-secondary",
                  )}
                >
                  {showHidden ? (
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  )}
                  <span>Hidden ({hiddenGroups.length})</span>
                </button>
                {showHidden && (
                  <div className="space-y-1 pt-1">
                    {hiddenGroups.map((h) => (
                      <div key={h.key} className="flex items-center gap-1 px-0.5">
                        <span className="min-w-0 flex-1 truncate font-sans text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                          {h.label}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleHide(h.key)}
                          aria-label={`Unhide ${h.label}`}
                          title="Unhide"
                          className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-text-tertiary hover:text-text-secondary"
                        >
                          <Eye className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {trash.length > 0 && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowTrash((v) => !v)}
                  aria-expanded={showTrash}
                  title={showTrash ? "Collapse trash" : "Show trash"}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-1 rounded border-0 bg-transparent",
                    "px-0.5 py-1 text-left font-sans text-[0.625rem] font-semibold uppercase",
                    "tracking-[0.08em] text-text-tertiary hover:text-text-secondary",
                  )}
                >
                  {showTrash ? (
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  )}
                  <span>Trash ({trash.length})</span>
                </button>
                {showTrash && (
                  <div className="space-y-1 pt-1">
                    {trash.map((t) => (
                      <div key={t.path} className="flex items-center gap-1 px-0.5">
                        <span
                          className="min-w-0 flex-1 truncate text-[0.625rem] text-text-tertiary"
                          title={`${t.relDir}/${t.name}`}
                        >
                          {t.name}
                        </span>
                        {busyPath === t.path ? (
                          <Spinner aria-label="restoring" />
                        ) : (
                          <button
                            type="button"
                            onClick={() => void restoreEntry(t)}
                            aria-label={`Restore ${t.name}`}
                            title={`Restore to ${t.relDir}/`}
                            className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-text-tertiary hover:text-text-secondary"
                          >
                            <ArchiveRestore className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    ))}
                    <div className="px-0.5 text-[0.5625rem] text-text-tertiary/70">
                      No hard delete here — emptying trash is a board-side action.
                    </div>
                  </div>
                )}
              </div>
            )}

            {cronJobs && cronJobs.length > 0 && (
              <>
                <div className="px-0.5 pt-2 font-sans text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
                  Scheduled ({cronJobs.length})
                </div>
                {cronJobs.slice(0, MAX_CRON_CARDS).map((job, i) => {
                  const scheduleText = scheduleLabel(job);
                  const lastStatusText = stringOr(job.last_status);
                  const jobEnabled = job.enabled !== false;
                  return (
                    <div
                      key={stringOr(job.id) || `${jobLabel(job)}-${i}`}
                      className="rounded-lg border border-current/10 bg-card px-2.5 py-2 shadow-sm"
                    >
                      <div className="flex items-center gap-1.5 text-xs">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            jobEnabled ? "bg-[var(--ds-green)]" : "bg-muted-foreground",
                          )}
                        />
                        <span className="truncate font-semibold">{jobLabel(job)}</span>
                      </div>
                      {(scheduleText || lastStatusText) && (
                        <div className="mt-0.5 pl-3 text-[0.625rem] text-text-tertiary">
                          {scheduleText && <span className="font-mono-ui">{scheduleText}</span>}
                          {scheduleText && lastStatusText && <span> · </span>}
                          {lastStatusText && <span>last: {lastStatusText}</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
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
