import { Moon, Sun } from "lucide-react";
import { Typography } from "@nous-research/ui/ui/components/typography/index";
import type { StatusResponse } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useTheme } from "@/themes";

// DigiSpark v1.2: quick light/dark flip lives in the footer, next to the
// auth row — the full ThemeSwitcher (all presets + fonts) stays under the
// Advanced disclosure. "midnight" is the registered slot DigiSpark Dark
// repurposes (see themes/presets.ts).
const LIGHT_THEME = "default";
const DARK_THEME = "midnight";

export function SidebarFooter({ status }: SidebarFooterProps) {
  const { t } = useI18n();
  const { themeName, setTheme } = useTheme();
  const isDark = themeName === DARK_THEME;
  const toggleLabel = isDark
    ? "Switch to DigiSpark Light"
    : "Switch to DigiSpark Dark";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-2",
        "px-5 py-2.5",
        "border-t border-current/10",
      )}
    >
      <Typography
        className="font-mono-ui text-xs tabular-nums tracking-[0.08em] text-text-tertiary lowercase"
      >
        {status?.version != null ? `v${status.version}` : "—"}
      </Typography>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setTheme(isDark ? LIGHT_THEME : DARK_THEME)}
          aria-label={toggleLabel}
          title={toggleLabel}
          className={cn(
            "flex h-6 w-6 cursor-pointer items-center justify-center rounded",
            "border-0 bg-transparent text-text-tertiary",
            "transition-colors hover:bg-current/10 hover:text-midground",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40",
          )}
        >
          {isDark ? (
            <Sun className="h-3.5 w-3.5" />
          ) : (
            <Moon className="h-3.5 w-3.5" />
          )}
        </button>

        <a
          href="https://nousresearch.com"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "font-sans text-display text-xs tracking-[0.12em] text-midground",
            "transition-opacity hover:opacity-90",
            "focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40",
          )}
        >
          {t.app.footer.org}
        </a>
      </div>
    </div>
  );
}

interface SidebarFooterProps {
  status: StatusResponse | null;
}
