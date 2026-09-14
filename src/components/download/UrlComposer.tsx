/**
 * The URL composer: the single most important control in the application.
 *
 * It accepts one link, many links (one per line), a whole playlist or a dropped piece
 * of text, and it owns every visual state the user can be in: idle, hover, focus,
 * parsing, success and error.
 */

import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle2,
  ClipboardPaste,
  Link2,
  Loader2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button, IconButton } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Feedback";
import { Tooltip } from "@/components/ui/Overlay";
import { cn } from "@/lib/cn";
import { bus, on } from "@/lib/bus";
import { duration, ease } from "@/lib/motion";
import type { UrlCheck } from "@/types/models";

export type ComposerStatus = "idle" | "parsing" | "parsed" | "error";

export interface UrlComposerProps {
  status: ComposerStatus;
  checks: UrlCheck[];
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onClear: () => void;
  errorMessage?: string | null;
  /** A short summary of what happened last time the link was parsed. */
  successMessage?: string | null;
  autoFocus?: boolean;
}

export function UrlComposer({
  status,
  checks,
  value,
  onValueChange,
  onSubmit,
  onCancel,
  onClear,
  errorMessage,
  successMessage,
  autoFocus = false,
}: UrlComposerProps) {
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const parsing = status === "parsing";
  const validCount = checks.filter((check) => check.valid).length;
  const invalidChecks = checks.filter((check) => !check.valid);
  const hasText = value.trim().length > 0;

  useEffect(() => {
    const disposeFocus = on(bus.focusUrl, () => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    });
    const disposePaste = on<string>(bus.paste, (text) => {
      if (!text) {
        return;
      }
      onValueChange(text.trim());
      // Let the paste settle before parsing so the field shows the link first.
      window.setTimeout(() => {
        textareaRef.current?.focus();
      }, 30);
    });
    return () => {
      disposeFocus();
      disposePaste();
    };
  }, [onValueChange]);

  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      onSubmit();
    }
  };

  const handlePasteButton = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        onValueChange(text.trim());
        textareaRef.current?.focus();
      }
    } catch {
      textareaRef.current?.focus();
    }
  };

  return (
    <motion.section
      layout
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const text =
          event.dataTransfer.getData("text/plain") ||
          event.dataTransfer.getData("text/uri-list") ||
          event.dataTransfer.getData("text");
        if (text.trim()) {
          onValueChange(text.trim());
        }
      }}
      className={cn(
        "relative rounded-[var(--radius-xl)] border bg-surface transition-all",
        dragging
          ? "border-accent bg-accent-soft"
          : focused
            ? "border-accent shadow-[var(--shadow-glow)]"
            : "border-line hover:border-line-strong",
      )}
      style={{ transitionDuration: `${duration.normal * 1000}ms`, transitionTimingFunction: `cubic-bezier(${ease.standard.join(",")})` }}
    >
      <div className="flex items-start gap-3 p-3.5">
        <div
          className={cn(
            "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border transition-colors",
            status === "error"
              ? "border-danger/30 bg-danger-soft text-danger"
              : status === "parsed"
                ? "border-success/30 bg-success-soft text-success"
                : "border-line bg-surface-muted text-content-tertiary",
          )}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={status}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={{ duration: duration.fast, ease: ease.out }}
              className="inline-flex"
            >
              {status === "error" ? (
                <AlertCircle className="size-4" />
              ) : status === "parsed" ? (
                <CheckCircle2 className="size-4" />
              ) : (
                <Link2 className="size-4" />
              )}
            </motion.span>
          </AnimatePresence>
        </div>

        <div className="min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            rows={value.includes("\n") ? 4 : 2}
            placeholder={"粘贴视频、播放列表或频道链接\n每行一个链接，可一次添加多个"}
            aria-label="视频链接"
            aria-invalid={status === "error" || undefined}
            className={cn(
              "w-full resize-none bg-transparent text-body leading-[1.5rem] text-content outline-none",
              "placeholder:text-content-tertiary",
            )}
          />
        </div>

        {hasText ? (
          <IconButton
            label="清空"
            size="sm"
            onClick={() => {
              onClear();
              textareaRef.current?.focus();
            }}
          >
            <X className="size-3.5" />
          </IconButton>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line-subtle px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-caption text-content-tertiary">
          <AnimatePresence mode="wait" initial={false}>
            {errorMessage ? (
              <motion.span
                key="error"
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                className="truncate text-danger"
                title={errorMessage}
              >
                {errorMessage}
              </motion.span>
            ) : successMessage ? (
              <motion.span
                key="success"
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                className="truncate text-success"
              >
                {successMessage}
              </motion.span>
            ) : invalidChecks.length > 0 ? (
              <motion.span
                key="invalid"
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                className="truncate text-warning"
              >
                {invalidChecks.length} 个链接无法识别，已忽略
              </motion.span>
            ) : (
              <motion.span
                key="hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2"
              >
                <Kbd>Ctrl</Kbd>
                <span className="text-content-tertiary">+</span>
                <Kbd>V</Kbd>
                <span>粘贴 · </span>
                <Kbd>Ctrl</Kbd>
                <span className="text-content-tertiary">+</span>
                <Kbd>Enter</Kbd>
                <span>解析 · 也可以直接拖入文本</span>
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Tooltip label="从剪贴板粘贴">
            <Button
              size="sm"
              variant="ghost"
              icon={<ClipboardPaste className="size-3.5" />}
              onClick={() => void handlePasteButton()}
            >
              粘贴
            </Button>
          </Tooltip>

          {hasText ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="size-3.5" />}
              onClick={onClear}
            >
              清空
            </Button>
          ) : null}

          {parsing ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<X className="size-3.5" />}
              onClick={onCancel}
            >
              停止解析
            </Button>
          ) : null}

          <Button
            size="sm"
            variant="primary"
            disabled={!hasText || parsing}
            loading={parsing}
            icon={
              parsing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : validCount > 1 ? (
                <Sparkles className="size-3.5" />
              ) : undefined
            }
            onClick={onSubmit}
          >
            {validCount > 1 ? `解析 ${validCount} 个链接` : "解析"}
          </Button>
        </div>
      </div>

      {/* Drop affordance floats above the card rather than shifting the layout. */}
      <AnimatePresence>
        {dragging ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: duration.fast }}
            className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[var(--radius-xl)] bg-accent-soft/70 backdrop-blur-[1px]"
          >
            <span className="text-label font-medium text-accent">松开以识别链接</span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.section>
  );
}
