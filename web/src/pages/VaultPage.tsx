/**
 * VaultPage — the vault power page (DigiSpark v1.4, wireframe-approved
 * 2026-07-14). Full-surface management for /opt/data/vault/deliverables,
 * the sibling of the Sessions power page. The WorkspaceRail stays the
 * glanceable browse/download surface; this page is where curation happens.
 *
 * Headline fix over the rail's per-file trash: archive and restore are
 * ARTIFACT-GROUPED — one action moves the .md source plus every rendered
 * output (pdf/docx/…) as a unit, and restore rejoins a stem's files so a
 * partial restore can't strand an artifact (the rail footgun: restoring
 * only a PDF left no card, because cards key off the .md source).
 *
 * All mutation rides the EXISTING gateway files API (listFiles / readFile /
 * uploadFile / createDirectory / deleteFile) exactly as the rail v1.3.5
 * archive does — COPY-THEN-DELETE so a mid-move failure can duplicate bytes
 * but never lose them. These are DASHBOARD-USER actions: the agent gains no
 * capability, and there is NO hard delete anywhere here — emptying _trash/
 * stays a board-side human action (the standing invariant).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArchiveRestore,
  Check,
  Download,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { ConfirmDialog } from "@nous-research/ui/ui/components/confirm-dialog";
import { usePageHeader } from "@/contexts/usePageHeader";
import { api } from "@/lib/api";
import type { ManagedFileEntry } from "@/lib/api";

const VAULT_ROOT = "/opt/data/vault";
const VAULT_DIR = `${VAULT_ROOT}/deliverables`;
const TRASH_DIR = `${VAULT_ROOT}/_trash`;
const ERRORS_DIR = `${VAULT_ROOT}/_render/errors`;
const STATUS_FILE = `${VAULT_ROOT}/_render/status.md`;
const BULK_CAP = 20;
const YEAR_RE = /^\d{4}$/;

const CLASS_LABELS: Record<string, string> = {
  "news-digest": "News digest",
  triage: "Triage",
  research: "Research",
  ops: "Ops",
  client: "Client",
};

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

interface Artifact {
  stem: string;
  groupLabel: string;
  sourceName: string;
  sourcePath: string;
  sourceMtime: number;
  outputs: { ext: string; path: string; name: string }[];
  expectedExts: string[];
  state: "rendering" | "rendered" | "error";
}

interface TrashArtifact {
  stem: string;
  relDir: string; // e.g. "deliverables/research/peraton"
  files: { name: string; path: string }[];
}

function relTime(unixSeconds: number): string {
  const d = Date.now() / 1000 - unixSeconds;
  if (d < 90) return `${Math.max(1, Math.round(d))}s ago`;
  if (d < 5400) return `${Math.round(d / 60)}m ago`;
  if (d < 86400 * 2) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
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

function downloadDataUrl(dataUrl: string, name: string) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = name || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function listDirSafe(path: string): Promise<ManagedFileEntry[]> {
  try {
    const res = await api.listFiles(path);
    return res.entries;
  } catch {
    return [];
  }
}

/** read -> mkdir -> upload copy -> delete original. Bytes never lost. */
async function moveFile(srcPath: string, destDir: string, name: string): Promise<void> {
  const f = await api.readFile(srcPath);
  const res = await fetch(f.data_url);
  const blob = await res.blob();
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  await api.createDirectory(destDir).catch(() => undefined); // may already exist
  await api.uploadFile(`${destDir}/${name}`, file, true);
  await api.deleteFile(srcPath);
}

/** Group a flat file listing into artifacts (source + attached outputs). */
function groupArtifacts(
  entries: ManagedFileEntry[],
  errorNames: Set<string>,
  groupLabel: string,
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
    if (stem === null) continue; // outputs attach below
    const outputs: Artifact["outputs"] = [];
    for (const ext of ["pdf", "docx", "pptx", "xlsx"]) {
      const hit = byName.get(`${stem}.${ext}`);
      if (hit) outputs.push({ ext, path: hit.path, name: hit.name });
    }
    const hasError = errorNames.has(`${f.name}.txt`);
    const missing = expected.some((ext) => !outputs.some((o) => o.ext === ext));
    arts.push({
      stem,
      groupLabel,
      sourceName: f.name,
      sourcePath: f.path,
      sourceMtime: f.mtime,
      outputs,
      expectedExts: expected,
      state: hasError ? "error" : missing ? "rendering" : "rendered",
    });
  }
  return arts;
}

/** Full walk of the vault tree (unbounded, unlike the rail's capped view). */
async function gatherAll(errorNames: Set<string>): Promise<Artifact[]> {
  const out: Artifact[] = [];
  const root = await listDirSafe(VAULT_DIR);
  const rootFiles = root.filter((e) => !e.is_directory);
  if (rootFiles.length) out.push(...groupArtifacts(rootFiles, errorNames, "Other"));
  for (const dir of root.filter((e) => e.is_directory)) {
    const label = CLASS_LABELS[dir.name] ?? dir.name;
    const entries = await listDirSafe(`${VAULT_DIR}/${dir.name}`);
    const flat = entries.filter((e) => !e.is_directory);
    for (const sub of entries.filter((e) => e.is_directory)) {
      const subFiles = (await listDirSafe(`${VAULT_DIR}/${dir.name}/${sub.name}`))
        .filter((e) => !e.is_directory);
      if (YEAR_RE.test(sub.name)) {
        flat.push(...subFiles);
      } else if (subFiles.length) {
        out.push(...groupArtifacts(subFiles, errorNames, `${label} · ${sub.name}`));
      }
    }
    if (flat.length) out.push(...groupArtifacts(flat, errorNames, label));
  }
  out.sort((a, b) => (b.sourceMtime ?? 0) - (a.sourceMtime ?? 0));
  return out;
}

/** Walk _trash/deliverables and rejoin files into artifacts by stem. */
async function gatherTrash(): Promise<TrashArtifact[]> {
  const flat: { name: string; path: string; relDir: string }[] = [];
  const take = (entries: ManagedFileEntry[], relDir: string) => {
    for (const e of entries) if (!e.is_directory) flat.push({ name: e.name, path: e.path, relDir });
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
  // Rejoin by stem (strip a known extension); files in the same relDir with
  // the same stem are one artifact.
  const byKey = new Map<string, TrashArtifact>();
  for (const f of flat) {
    const stem = f.name.replace(/\.(pdf|docx|pptx|xlsx|deck\.md|sheet\.json|md)$/i, "");
    const key = `${f.relDir}::${stem}`;
    const existing = byKey.get(key);
    if (existing) existing.files.push({ name: f.name, path: f.path });
    else byKey.set(key, { stem, relDir: f.relDir, files: [{ name: f.name, path: f.path }] });
  }
  return [...byKey.values()].sort((a, b) => a.stem.localeCompare(b.stem));
}

const STATE_TONE: Record<Artifact["state"], "success" | "warning" | "destructive"> = {
  rendered: "success",
  rendering: "warning",
  error: "destructive",
};

export default function VaultPage() {
  const { toast, showToast } = useToast();
  const { setEnd } = usePageHeader();
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [trash, setTrash] = useState<TrashArtifact[]>([]);
  const [heartbeat, setHeartbeat] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let errorNames = new Set<string>();
      try {
        const errs = await api.listFiles(ERRORS_DIR);
        errorNames = new Set(errs.entries.filter((e) => !e.is_directory).map((e) => e.name));
      } catch {
        /* no errors dir yet — fine */
      }
      setArtifacts(await gatherAll(errorNames));
      setTrash(await gatherTrash());
      setError(null);
      try {
        const status = await api.readFile(STATUS_FILE);
        const m = decodeDataUrl(status.data_url).match(/last-run:\s*(\S+)/);
        const t = m ? Date.parse(m[1]) / 1000 : NaN;
        setHeartbeat(Number.isFinite(t) ? relTime(t) : null);
      } catch {
        setHeartbeat(null);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setEnd(
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1 text-xs text-text-tertiary">
          {heartbeat ? (
            <>
              <Check className="h-3 w-3 text-success" /> render {heartbeat}
            </>
          ) : (
            <>
              <AlertCircle className="h-3 w-3 text-warning" /> render status unknown
            </>
          )}
        </span>
        <Button
          ghost
          size="icon"
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh vault"
        >
          {loading ? <Spinner /> : <RefreshCw />}
        </Button>
      </div>,
    );
    return () => setEnd(null);
  }, [heartbeat, load, loading, setEnd]);

  const filtered = useMemo(() => {
    const list = artifacts ?? [];
    const q = query.trim().toLowerCase();
    const matched = q
      ? list.filter(
          (a) =>
            a.stem.toLowerCase().includes(q) || a.groupLabel.toLowerCase().includes(q),
        )
      : list;
    const groups = new Map<string, Artifact[]>();
    for (const a of matched) {
      const arr = groups.get(a.groupLabel);
      if (arr) arr.push(a);
      else groups.set(a.groupLabel, [a]);
    }
    return [...groups.entries()];
  }, [artifacts, query]);

  const toggleSel = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /** Archive one artifact: move source + outputs to _trash preserving the
   * deliverables-relative path, then clear its render-error record. */
  const archiveOne = useCallback(async (a: Artifact) => {
    const targets = [
      { path: a.sourcePath, name: a.sourceName },
      ...a.outputs.map((o) => ({ path: o.path, name: o.name })),
    ];
    for (const t of targets) {
      const rel = t.path.startsWith(`${VAULT_DIR}/`) ? t.path.slice(VAULT_DIR.length + 1) : t.name;
      const relDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const destDir = relDir ? `${TRASH_DIR}/deliverables/${relDir}` : `${TRASH_DIR}/deliverables`;
      await moveFile(t.path, destDir, t.name);
    }
    await api.deleteFile(`${ERRORS_DIR}/${a.sourceName}.txt`).catch(() => undefined);
  }, []);

  const archiveArtifact = useCallback(
    async (a: Artifact) => {
      setBusy(a.sourcePath);
      try {
        await archiveOne(a);
        showToast(`Archived ${a.stem}`, "success");
      } catch (e) {
        setError(`Archive failed (nothing lost — copy-then-delete): ${String(e)}`);
      } finally {
        setBusy(null);
        setSelected(new Set());
        void load();
      }
    },
    [archiveOne, load, showToast],
  );

  const archiveSelected = useCallback(async () => {
    setConfirmBulk(false);
    const byPath = new Map((artifacts ?? []).map((a) => [a.sourcePath, a]));
    const picked = [...selected].map((p) => byPath.get(p)).filter(Boolean) as Artifact[];
    const capped = picked.slice(0, BULK_CAP);
    setBusy("__bulk__");
    let ok = 0;
    try {
      for (const a of capped) {
        try {
          await archiveOne(a);
          ok++;
        } catch (e) {
          setError(`Archive failed on ${a.stem} (nothing lost): ${String(e)}`);
        }
      }
      showToast(`Archived ${ok} artifact${ok === 1 ? "" : "s"}`, "success");
    } finally {
      setBusy(null);
      setSelected(new Set());
      void load();
    }
  }, [archiveOne, artifacts, load, selected, showToast]);

  const restoreArtifact = useCallback(
    async (ta: TrashArtifact) => {
      setBusy(`trash:${ta.relDir}::${ta.stem}`);
      try {
        for (const f of ta.files) {
          await moveFile(f.path, `${VAULT_ROOT}/${ta.relDir}`, f.name);
        }
        showToast(`Restored ${ta.stem}`, "success");
      } catch (e) {
        setError(`Restore failed (nothing lost — copy-then-delete): ${String(e)}`);
      } finally {
        setBusy(null);
        void load();
      }
    },
    [load, showToast],
  );

  const downloadArtifact = useCallback(
    async (a: Artifact) => {
      const primary = a.outputs[0] ?? { path: a.sourcePath, name: a.sourceName };
      try {
        const f = await api.readFile(primary.path);
        downloadDataUrl(f.data_url, f.name);
      } catch (e) {
        showToast(`Download failed: ${e}`, "error");
      }
    },
    [showToast],
  );

  const selCount = selected.size;

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-4">
      <Toast toast={toast} />

      <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="relative min-w-0 flex-1 xl:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search filename or project…"
            aria-label="Search vault"
            className="h-9 pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            outlined
            disabled={selCount === 0 || busy !== null}
            onClick={() => setConfirmBulk(true)}
            prefix={busy === "__bulk__" ? <Spinner /> : <Trash2 />}
            className="uppercase"
          >
            Archive selected ({selCount})
          </Button>
          {selCount > BULK_CAP && (
            <span className="text-xs text-warning">first {BULK_CAP} per action</span>
          )}
        </div>
      </div>

      <Card className="min-w-0 max-w-full overflow-hidden">
        <CardContent className="overflow-x-auto p-0">
          {error && (
            <div className="border-b border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="grid min-w-[46rem] grid-cols-[2rem_minmax(14rem,1fr)_7rem_9rem_10rem_7rem] items-center gap-3 border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-tertiary">
            <span />
            <span>Artifact</span>
            <span>State</span>
            <span>Files</span>
            <span>Modified</span>
            <span className="text-right">Actions</span>
          </div>

          {artifacts === null ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Spinner /> Loading vault…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {query ? "No artifacts match your search." : "No deliverables yet."}
            </div>
          ) : (
            filtered.map(([label, arts]) => (
              <div key={label}>
                <div className="min-w-[46rem] border-b border-border/60 bg-background/40 px-4 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                  {label} <span className="text-text-tertiary">({arts.length})</span>
                </div>
                {arts.map((a) => (
                  <div
                    key={a.sourcePath}
                    className="grid min-w-[46rem] grid-cols-[2rem_minmax(14rem,1fr)_7rem_9rem_10rem_7rem] items-center gap-3 border-b border-border/60 px-4 py-2 text-sm last:border-b-0 hover:bg-background/35"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(a.sourcePath)}
                      onChange={() => toggleSel(a.sourcePath)}
                      aria-label={`Select ${a.stem}`}
                    />
                    <span className="min-w-0 truncate font-mono text-foreground" title={a.stem}>
                      {a.stem}
                    </span>
                    <span>
                      <Badge tone={STATE_TONE[a.state]} className="text-[0.5625rem] uppercase">
                        {a.state}
                      </Badge>
                    </span>
                    <span className="flex flex-wrap gap-1">
                      <span className="rounded border border-current/10 px-1 text-[0.5625rem] font-semibold text-text-secondary">
                        SRC
                      </span>
                      {a.outputs.map((o) => (
                        <span
                          key={o.ext}
                          className="rounded border border-current/10 px-1 text-[0.5625rem] font-semibold uppercase text-text-secondary"
                        >
                          {o.ext}
                        </span>
                      ))}
                    </span>
                    <span className="truncate text-xs text-text-secondary">
                      {Number.isFinite(a.sourceMtime)
                        ? DATE_FORMAT.format(a.sourceMtime * 1000)
                        : "-"}
                    </span>
                    <span className="flex justify-end gap-1">
                      <Button
                        ghost
                        size="icon"
                        type="button"
                        onClick={() => void downloadArtifact(a)}
                        aria-label={`Download ${a.stem}`}
                      >
                        <Download />
                      </Button>
                      {busy === a.sourcePath ? (
                        <span className="flex h-8 w-8 items-center justify-center">
                          <Spinner />
                        </span>
                      ) : (
                        <Button
                          ghost
                          size="icon"
                          type="button"
                          onClick={() => void archiveArtifact(a)}
                          aria-label={`Archive ${a.stem}`}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {trash.length > 0 && (
        <Card className="min-w-0 max-w-full overflow-hidden">
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="text-xs font-semibold uppercase tracking-[0.08em] text-text-secondary">
                Trash ({trash.length})
              </span>
              <span className="text-[0.625rem] text-text-tertiary">
                No hard delete here — emptying trash is a board-side action.
              </span>
            </div>
            {trash.map((ta) => {
              const key = `trash:${ta.relDir}::${ta.stem}`;
              return (
                <div
                  key={key}
                  className="flex items-center gap-3 border-b border-border/60 px-4 py-2 text-sm last:border-b-0"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-foreground" title={ta.stem}>
                      {ta.stem}
                    </span>
                    <span className="block truncate text-[0.625rem] text-text-tertiary">
                      was {ta.relDir} · {ta.files.length} file{ta.files.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  {busy === key ? (
                    <span className="flex h-8 w-8 items-center justify-center">
                      <Spinner />
                    </span>
                  ) : (
                    <Button
                      ghost
                      size="sm"
                      type="button"
                      onClick={() => void restoreArtifact(ta)}
                      prefix={<ArchiveRestore className="h-4 w-4" />}
                      className="uppercase"
                    >
                      Restore all
                    </Button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirmBulk}
        cancelLabel="Cancel"
        confirmLabel={`Archive ${Math.min(selCount, BULK_CAP)}`}
        title="Archive selected artifacts?"
        description={
          `This moves ${Math.min(selCount, BULK_CAP)} artifact${selCount === 1 ? "" : "s"} ` +
          `(source + all rendered outputs) to trash. Restorable from the Trash panel; ` +
          `nothing is hard-deleted.` +
          (selCount > BULK_CAP ? ` Only the first ${BULK_CAP} will be archived this pass.` : "")
        }
        onCancel={() => setConfirmBulk(false)}
        onConfirm={() => void archiveSelected()}
      />
    </div>
  );
}
