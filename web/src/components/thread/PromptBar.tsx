/**
 * PromptBar — blocking gateway prompts rendered inline above the composer.
 *
 * approval.request → Run once / Allow this session / Always allow (confirmed)
 * / Deny, with the command revealed in a mono block (the agent thread blocks
 * server-side until answered; deny is the safe default posture).
 * clarify.request → question + choice buttons or free-text answer.
 * sudo/secret.request → masked input.
 *
 * Interaction design follows the desktop's tool/approval.tsx.
 */

import { Button } from "@nous-research/ui/ui/components/button";
import { ConfirmDialog } from "@nous-research/ui/ui/components/confirm-dialog";
import { ShieldAlert, MessageCircleQuestion, KeyRound } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import type { PendingPrompt } from "@/hooks/useChatThread";

interface Props {
  prompt: PendingPrompt;
  onApproval(choice: "once" | "session" | "always" | "deny"): void;
  onClarify(answer: string): void;
  onSecret(value: string): void;
}

export function PromptBar({ prompt, onApproval, onClarify, onSecret }: Props) {
  const [confirmAlways, setConfirmAlways] = useState(false);
  const [text, setText] = useState("");

  const shell = (icon: React.ReactNode, title: string, body: React.ReactNode) => (
    <div
      className={cn(
        "rounded-lg border border-[color-mix(in_srgb,var(--ds-warm)_45%,transparent)]",
        "bg-[color-mix(in_srgb,var(--ds-warm)_7%,var(--background-base))]",
        "px-4 py-3 shadow-sm",
      )}
      role="alertdialog"
      aria-label={title}
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
        {icon}
        {title}
      </div>
      {body}
    </div>
  );

  if (prompt.kind === "approval") {
    return shell(
      <ShieldAlert className="h-4 w-4 text-[var(--ds-warm)]" />,
      prompt.description || "The agent wants to run a flagged action",
      <>
        {prompt.command && (
          <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-midground/5 px-3 py-2 font-mono-ui text-xs text-text-secondary">
            {prompt.command}
          </pre>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => onApproval("once")}
            className="!bg-[var(--ds-accent)] !text-white hover:!bg-[var(--ds-accent-hover)] normal-case tracking-normal">
            Run once
          </Button>
          <Button size="sm" outlined onClick={() => onApproval("session")}
            className="normal-case tracking-normal">
            Allow this session
          </Button>
          {prompt.allowPermanent !== false && (
            <Button size="sm" outlined onClick={() => setConfirmAlways(true)}
              className="normal-case tracking-normal">
              Always allow
            </Button>
          )}
          <Button size="sm" ghost onClick={() => onApproval("deny")}
            className="text-destructive normal-case tracking-normal">
            Deny
          </Button>
        </div>
        <ConfirmDialog
          open={confirmAlways}
          title="Always allow this pattern?"
          description="This adds the command pattern to the permanent allowlist in config.yaml — future matches run without asking."
          confirmLabel="Always allow"
          cancelLabel="Cancel"
          onConfirm={() => {
            setConfirmAlways(false);
            onApproval("always");
          }}
          onCancel={() => setConfirmAlways(false)}
        />
      </>,
    );
  }

  if (prompt.kind === "clarify") {
    return shell(
      <MessageCircleQuestion className="h-4 w-4 text-[var(--ds-accent)]" />,
      prompt.question || "The agent needs a decision",
      <div className="flex flex-col gap-2">
        {prompt.choices && prompt.choices.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {prompt.choices.map((c) => (
              <Button key={c} size="sm" outlined onClick={() => onClarify(c)}
                className="normal-case tracking-normal">
                {c}
              </Button>
            ))}
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) onClarify(text.trim());
            }}
          >
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="min-w-0 flex-1 rounded border border-current/15 bg-card px-3 py-1.5 text-sm outline-none focus:border-[var(--ds-accent)]"
              placeholder="Type your answer…"
            />
            <Button size="sm" type="submit" className="normal-case tracking-normal">
              Answer
            </Button>
          </form>
        )}
      </div>,
    );
  }

  // sudo / secret — masked input.
  const label =
    prompt.kind === "sudo"
      ? "The agent needs the sudo password"
      : prompt.promptText || `The agent needs a value for ${prompt.envVar ?? "a secret"}`;
  return shell(
    <KeyRound className="h-4 w-4 text-[var(--ds-warm)]" />,
    label,
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text) onSecret(text);
        setText("");
      }}
    >
      <input
        autoFocus
        type="password"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="min-w-0 flex-1 rounded border border-current/15 bg-card px-3 py-1.5 text-sm outline-none focus:border-[var(--ds-accent)]"
        placeholder="Enter value (sent only to the gateway)"
      />
      <Button size="sm" type="submit" className="normal-case tracking-normal">
        Send
      </Button>
    </form>,
  );
}
