"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, CornerDownLeft } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConversationDensityContext } from "@/components/conversation-density";
import { type ChatModelOverride, ModelPicker } from "@/components/ModelPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useConversationInputs } from "@/features/conversations/hooks";
import { conversationKeys } from "@/features/conversations/query-keys";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type SkillCommand, slashCommands } from "@/lib/slash-commands";
import { cn } from "@/lib/utils";
import { ComposerInputQueue } from "./ComposerInputQueue";

/** Composer metrics: the design prototype's well — auto height 52–180px, radius 13. */
const COMPOSER_MIN_H = 52;
const COMPOSER_MAX_H = 180;

/** One row of the `/` picker: a client command, or a skill the agent can load. */
interface PickerItem {
  command: string;
  description: string;
  argsHint?: string;
  skill: boolean;
}

interface ComposerProps {
  conversationId: string;
  onSend: (
    message: string,
    model?: ChatModelOverride,
    attachments?: readonly { type: "image"; mediaType: string; base64: string }[],
  ) => void;
  onSlashCommand: (input: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** A run is live: the send button becomes the red-dot Stop. */
  isBusy?: boolean;
  onStop?: () => void;
  /** Skills offered in the `/` picker after the commands; completing one only names it. */
  skills?: readonly SkillCommand[];
  /** A draft put into the input while it is empty, for the person to edit and send. */
  draft?: string;
}
export function Composer({
  conversationId,
  onSend,
  onSlashCommand,
  disabled,
  placeholder = t("Type a message… Ctrl+Enter to send"),
  isBusy,
  onStop,
  skills,
  draft,
}: ComposerProps) {
  const [model, setModel] = useState<ChatModelOverride | null>(() => {
    try {
      const raw = localStorage.getItem(`oma.chat.model:${conversationId}`);
      return raw ? (JSON.parse(raw) as ChatModelOverride) : null;
    } catch {
      return null;
    }
  });
  const pickModel = useCallback(
    (m: ChatModelOverride | null) => {
      setModel(m);
      try {
        if (m) localStorage.setItem(`oma.chat.model:${conversationId}`, JSON.stringify(m));
        else localStorage.removeItem(`oma.chat.model:${conversationId}`);
      } catch {
        /* storage unavailable — selection stays per-mount */
      }
    },
    [conversationId],
  );
  const [value, setValue] = useState("");
  const [showSlash, setShowSlash] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  // @artifact autocomplete: typing "@" as the last char opens the artifact
  // picker; selecting inserts the artifacts:// URL (the agent downloads the
  // content itself via its artifact_download tool).
  const [showArtifact, setShowArtifact] = useState(false);
  const [artifactIndex, setArtifactIndex] = useState(0);
  const [artifactUrls, setArtifactUrls] = useState<string[]>([]);
  useEffect(() => {
    api
      .listArtifacts()
      .then((r) => setArtifactUrls((r.artifacts ?? []).map((a) => a.url)))
      .catch(() => {});
  }, []);
  const [artifactQuery, setArtifactQuery] = useState("");
  const filteredArtifacts = useMemo(() => {
    const q = artifactQuery.trim().toLowerCase();
    const list = q ? artifactUrls.filter((u) => u.toLowerCase().includes(q)) : artifactUrls;
    return list.slice(0, 8);
  }, [artifactUrls, artifactQuery]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [attachments, setAttachments] = useState<
    readonly { type: "image"; mediaType: string; base64: string }[]
  >([]);

  // Pending input queue: backend branch_input_queue for this conversation.
  // Polls only while something is waiting; mutations refetch immediately.
  const qc = useQueryClient();
  const inputsQuery = useConversationInputs(conversationId);
  const invalidateQueue = useCallback(() => {
    qc.invalidateQueries({ queryKey: conversationKeys.inputs(conversationId) });
  }, [qc, conversationId]);
  const steerMut = useMutation({
    mutationFn: (inputId: string) => api.steerConversationInput(conversationId, inputId),
    onSuccess: invalidateQueue,
    onError: () => toast.error("Failed to send now — the run may have ended"),
  });
  const editMut = useMutation({
    mutationFn: (args: { inputId: string; text: string }) =>
      api.updateConversationInput(conversationId, args.inputId, args.text),
    onSuccess: invalidateQueue,
    onError: () => toast.error("Edit failed — this input was already processed"),
  });
  const cancelMut = useMutation({
    mutationFn: (inputId: string) => api.cancelConversationInput(conversationId, inputId),
    onSuccess: invalidateQueue,
    onError: () => toast.error("Cancel failed"),
  });

  const filteredSlash = useMemo(() => {
    const q = value.trim().toLowerCase();
    // Commands run here; a skill is only named in the message. One list, in that order.
    const items: PickerItem[] = slashCommands.map((c) => ({
      command: c.command,
      description: c.description,
      argsHint: c.argsHint,
      skill: false,
    }));
    for (const skill of skills ?? []) {
      items.push({ command: skill.command, description: skill.description, skill: true });
    }
    return items.filter((item) => item.command.startsWith(q));
  }, [value, skills]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - must reset when filter narrows options
  useEffect(() => {
    setSlashIndex(0);
  }, [showSlash]);
  const readImageFile = useCallback((file: File) => {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return;
      const comma = result.indexOf(",");
      if (comma < 0) return;
      setAttachments((prev) => [
        ...prev,
        { type: "image" as const, mediaType: file.type, base64: result.slice(comma + 1) },
      ]);
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) readImageFile(file);
        }
      }
    },
    [readImageFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      for (const file of Array.from(e.dataTransfer.files)) readImageFile(file);
    },
    [readImageFile],
  );

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = `${COMPOSER_MIN_H}px`;
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`;
  }, []);

  // An offered draft goes in only while the input is empty: it never replaces what the person
  // typed. The same text is offered once; a caller offers again by changing it.
  const [offeredDraft, setOfferedDraft] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (draft === undefined || draft === offeredDraft) return;
    if (value !== "") return;
    setOfferedDraft(draft);
    setValue(draft);
    autoGrow();
  }, [draft, offeredDraft, value, autoGrow]);

  // (resolveAddressedTo removed with client-side routing — server derives targets)

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const text = e.target.value;
      setValue(text);
      autoGrow();
      // Slash command popover: only while the input is a single token starting with "/"
      // (no spaces yet). Once args begin, the popover closes so typing continues freely.
      setShowSlash(text.startsWith("/") && !/\s/.test(text.trim()));
      // Artifact picker: an unfinished "@query" token at the end of the text.
      const atMatch = /(?:^|\s)@([^@\s]*)$/.exec(text);
      if (atMatch) {
        setShowArtifact(true);
        setArtifactQuery(atMatch[1] ?? "");
        setArtifactIndex(0);
      } else {
        setShowArtifact(false);
      }
    },
    [autoGrow],
  );

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    // Slash command: route to onSlashCommand instead of sending as a message.
    if (trimmed.startsWith("/")) {
      onSlashCommand(trimmed);
      setValue("");
      setShowSlash(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = `${COMPOSER_MIN_H}px`;
        textareaRef.current.focus();
      }
      return;
    }
    onSend(trimmed, model ?? undefined, attachments);
    setValue("");
    setAttachments([]);
    // Give the backend a beat to persist the queued input, then show it.
    setTimeout(() => void inputsQuery.refetch(), 400);
    if (textareaRef.current) {
      textareaRef.current.style.height = `${COMPOSER_MIN_H}px`;
    }
  }, [value, disabled, onSend, onSlashCommand, model, attachments, inputsQuery]);

  const navigateSlash = useCallback(
    (dir: -1 | 1) => {
      if (!showSlash || filteredSlash.length === 0) return;
      setSlashIndex((prev) => {
        const next = prev + dir;
        if (next < 0) return filteredSlash.length - 1;
        if (next >= filteredSlash.length) return 0;
        return next;
      });
    },
    [showSlash, filteredSlash.length],
  );

  const completeSlash = useCallback(() => {
    const idx = Math.min(slashIndex, filteredSlash.length - 1);
    const cmd = filteredSlash[idx];
    if (!cmd) return;
    // Complete to the command name + trailing space so the user can type args.
    setValue(`${cmd.command} `);
    setShowSlash(false);
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const cursor = cmd.command.length + 1;
      el.setSelectionRange(cursor, cursor);
    }, 0);
  }, [slashIndex, filteredSlash]);

  const completeArtifact = useCallback(() => {
    const url = filteredArtifacts[artifactIndex];
    if (!url) return;
    setValue((prev) => prev.replace(/@[^@\s]*$/, `${url} `));
    setShowArtifact(false);
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
  }, [filteredArtifacts, artifactIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showArtifact && filteredArtifacts.length > 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowArtifact(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setArtifactIndex((i) => (i + 1) % filteredArtifacts.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setArtifactIndex((i) => (i - 1 + filteredArtifacts.length) % filteredArtifacts.length);
        return;
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        completeArtifact();
        return;
      }
    }
    if (showSlash && filteredSlash.length > 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSlash(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        navigateSlash(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        navigateSlash(-1);
        return;
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        completeSlash();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        completeSlash();
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const effectivePlaceholder = placeholder;
  // An editor sheet embeds this at the prototype's tighter scale (see conversation-density).
  const tight = useContext(ConversationDensityContext) === "panel";

  return (
    <div className={cn("pt-2", tight ? "px-4 pb-4" : "px-6 pb-5")}>
      {inputsQuery.data && (
        <ComposerInputQueue
          inputs={inputsQuery.data.inputs}
          busy={steerMut.isPending || editMut.isPending || cancelMut.isPending}
          onSteer={(inputId) => steerMut.mutate(inputId)}
          onSave={(inputId, text) => editMut.mutate({ inputId, text })}
          onCancel={(inputId) => cancelMut.mutate(inputId)}
        />
      )}
      <div className="relative mx-auto" style={{ maxWidth: "72ch" }}>
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-2">
            {attachments.map((a, i) => (
              <div
                key={i}
                className="relative size-12 rounded-md border border-(--hairline) overflow-hidden"
                title="Attached image"
              >
                {/* biome-ignore lint/performance/noImgElement: data: URI — next/image cannot optimize inline base64 */}
                <img
                  src={`data:${a.mediaType};base64,${a.base64}`}
                  alt="attached"
                  className="size-full  object-cover"
                />
                <button
                  type="button"
                  aria-label="Remove image"
                  onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                  className="absolute top-0 right-0 bg-black/60 text-white text-[10px]/4 px-1 "
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className={cn(
            "rounded-[13px] border border-(--hairline) bg-[#1b1f22] transition-colors focus-within:border-(--primary)/60",
            tight ? "px-3.5 pt-3" : "px-4 pt-3.5",
          )}
        >
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={disabled ? t("Replying…") : effectivePlaceholder}
            rows={1}
            disabled={disabled}
            aria-label={t("Message")}
            className={cn(
              "w-full resize-none border-0 bg-transparent p-0 leading-relaxed text-(--ink) placeholder:text-(--faint) focus-visible:border-transparent focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-40",
              tight ? "text-[11px]" : "text-xs",
            )}
            style={{ minHeight: `${COMPOSER_MIN_H}px`, maxHeight: `${COMPOSER_MAX_H}px` }}
          />
          <div className="mt-1.5 flex items-center justify-between gap-2.5 pb-3">
            <ModelPicker value={model} onChange={pickModel} />
            {isBusy && onStop ? (
              <Button
                onClick={onStop}
                size="icon"
                className={cn(
                  "rounded-full bg-(--err)/15 hover:bg-(--err)/25",
                  tight ? "size-[32px]" : "size-[35px]",
                )}
                title="Stop run"
                aria-label="Stop"
              >
                <span className="size-2.5 rounded-full bg-(--err) animate-pulse" />
              </Button>
            ) : (
              <Button
                onClick={handleSend}
                disabled={disabled || !value.trim()}
                size="icon"
                className={cn(
                  "rounded-full bg-(--primary) text-[#172421] hover:bg-[rgb(201,248,223)]",
                  tight ? "size-[32px]" : "size-[35px]",
                )}
                aria-label="Send"
              >
                <ArrowUp size={16} className="shrink-0" />
              </Button>
            )}
          </div>
        </div>

        {/* Artifact picker popover */}
        {showArtifact && filteredArtifacts.length > 0 && (
          <div className="absolute bottom-full left-0 z-50 mb-2 w-96 overflow-hidden rounded-xl border border-(--hairline) bg-(--panel)">
            <div className="flex items-center justify-between border-b border-(--hairline) px-3 py-2">
              <span className="text-[10px] uppercase tracking-[1.8px] text-(--faint)">
                {t("Cite artifacts")}
              </span>
              <span className="flex items-center gap-1 text-[10px] text-(--mute)">
                <CornerDownLeft size={10} /> {t("Insert")}
              </span>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filteredArtifacts.map((u, i) => (
                <button
                  key={u}
                  type="button"
                  onClick={completeArtifact}
                  onMouseEnter={() => setArtifactIndex(i)}
                  className={`w-full truncate px-3 py-2 text-left font-mono text-[11px] transition-colors ${
                    i === artifactIndex
                      ? "bg-white/4 text-(--ink)"
                      : "text-(--mute) hover:bg-white/4"
                  }`}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Slash picker popover: commands first, then the skills this agent can load */}
        {showSlash && (
          <div className="absolute bottom-full left-0 z-50 mb-2 w-96 overflow-hidden rounded-xl border border-(--hairline) bg-(--panel)">
            <div className="flex items-center justify-between border-b border-(--hairline) px-3 py-2">
              <span className="text-[10px] uppercase tracking-[1.8px] text-(--faint)">
                {t("Commands and skills")}
              </span>
              <span className="flex items-center gap-1 text-[10px] text-(--mute)">
                <CornerDownLeft size={10} /> {t("Complete")}
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto py-1" role="listbox">
              {filteredSlash.length === 0 ? (
                <p className="p-3 text-xs text-(--mute)">{t("No matching commands")}</p>
              ) : (
                filteredSlash.map((c, i) => (
                  <button
                    key={c.command}
                    type="button"
                    role="option"
                    aria-selected={i === slashIndex}
                    onClick={completeSlash}
                    onMouseEnter={() => setSlashIndex(i)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                      i === slashIndex ? "bg-white/4" : "hover:bg-white/4"
                    }`}
                  >
                    <span className="shrink-0 font-mono text-xs text-(--ink)">
                      {c.command}
                      {c.argsHint && <span className="text-(--mute)"> {c.argsHint}</span>}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-(--mute)">
                      {c.description}
                    </span>
                    {c.skill && <Badge variant="secondary">{t("Skill")}</Badge>}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
