"use client";

import { Upload } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Note } from "@/components/ops/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResourceEditorSheet } from "@/components/ui/resource-editor-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useInstallGitPack, useUploadZipPack } from "@/features/skill-packs/hooks";
import { formatBytes, useFileUpload } from "@/hooks/use-file-upload";
import { t } from "@/lib/i18n";

type Source = "git" | "zip";

interface Draft {
  source: Source;
  /** Git: the repository URL. */
  origin: string;
  ref: string;
  keepSynced: boolean;
  name: string;
  description: string;
}

const EMPTY: Draft = {
  source: "git",
  origin: "",
  ref: "",
  keepSynced: false,
  name: "",
  description: "",
};

/** The register dialog: what a person typed, and one save that registers the pack and starts
 *  the install. The ZIP goes through the library's file input (`useFileUpload`), as before. */
export function InstallPackForm({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const git = useInstallGitPack();
  const zip = useUploadZipPack();
  const [{ files }, { openFileDialog, getInputProps, removeFile }] = useFileUpload({
    accept: ".zip",
    multiple: false,
    maxSize: 50 * 1024 * 1024,
    maxFiles: 1,
    onError: (errors) => setError(errors.join("; ")),
  });
  const file = files[0]?.file as File | undefined;
  const busy = git.isPending || zip.isPending;
  const dirty = JSON.stringify(draft) !== JSON.stringify(EMPTY) || file !== undefined;

  function set<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function chooseSource(value: string | null): void {
    set("source", value === "zip" ? "zip" : "git");
  }

  async function save(): Promise<void> {
    if (draft.name.trim() === "") {
      setError(t("The pack needs a name."));
      return;
    }
    if (draft.source === "git" && draft.origin.trim() === "") {
      setError(t("A Git source needs a repository URL."));
      return;
    }
    if (draft.source === "zip" && file === undefined) {
      setError(t("Choose a ZIP file."));
      return;
    }
    setError(null);
    try {
      if (draft.source === "git") {
        await git.mutateAsync({
          name: draft.name.trim(),
          description: draft.description,
          url: draft.origin.trim(),
          ref: draft.ref.trim() === "" ? undefined : draft.ref.trim(),
          keepSynced: draft.keepSynced,
        });
      } else if (file !== undefined) {
        await zip.mutateAsync({ name: draft.name.trim(), description: draft.description, file });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function pickFile(): void {
    setError(null);
    openFileDialog();
  }

  function clearFile(): void {
    for (const f of files) removeFile(f.id);
  }

  function chosen(): ReactNode {
    if (file === undefined) {
      return (
        <Button type="button" variant="outline" onClick={pickFile}>
          <Upload className="size-4" /> {t("Choose ZIP")}
        </Button>
      );
    }
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-white/6 bg-(--panel) px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs text-(--ink)">{file.name}</p>
          <p className="font-mono text-[10px] text-(--mute)">{formatBytes(file.size)}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={clearFile}>
          {t("Remove")}
        </Button>
      </div>
    );
  }

  return (
    <ResourceEditorSheet
      open
      kicker={t("REGISTER SKILL PACK")}
      title={t("Register skill pack")}
      description={t(
        "Saving registers the pack and starts the install: a Git source is cloned, a ZIP is uploaded.",
      )}
      onClose={onClose}
      dirty={dirty}
      footer={(requestClose) => (
        <>
          <Button variant="outline" onClick={requestClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? t("Registering…") : t("Register and install")}
          </Button>
        </>
      )}
    >
      <div className="space-y-4 p-6">
        <div className="space-y-2">
          <Label className="text-[11px] font-normal text-(--mute)">{t("Source type")}</Label>
          <Select value={draft.source} onValueChange={chooseSource}>
            <SelectTrigger className="w-full" aria-label={t("Source type")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="git">{t("Git · repository URL")}</SelectItem>
              <SelectItem value="zip">{t("ZIP · local file")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {draft.source === "git" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-[11px] font-normal text-(--mute)">
                {t("Repository URL *")}
              </Label>
              <Input
                value={draft.origin}
                onChange={(e) => set("origin", e.target.value)}
                placeholder="https://example.test/docs.git"
                className="font-mono"
              />
              <Note>
                {t(
                  "Every directory with a SKILL.md becomes one skill of the new pack. /tree/branch/path URLs are supported.",
                )}
              </Note>
            </div>
            <div className="space-y-2">
              <Label className="text-[11px] font-normal text-(--mute)">{t("Branch or ref")}</Label>
              <Input
                value={draft.ref}
                onChange={(e) => set("ref", e.target.value)}
                placeholder={t("Leave empty for the repository's default")}
                className="font-mono"
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-(--body)">
              <Checkbox
                checked={draft.keepSynced}
                onCheckedChange={(value) => set("keepSynced", value === true)}
              />
              {t("Keep synced with the Git repository (a manual sync stays available)")}
            </label>
          </div>
        ) : (
          <div className="space-y-2">
            <Label className="text-[11px] font-normal text-(--mute)">{t("ZIP file *")}</Label>
            <input {...getInputProps()} />
            {chosen()}
            <Note>
              {t(
                "One or more skill directories inside the ZIP are validated and imported into one new pack.",
              )}
            </Note>
          </div>
        )}

        <div className="space-y-2">
          <Label className="text-[11px] font-normal text-(--mute)">{t("Pack name *")}</Label>
          <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label className="text-[11px] font-normal text-(--mute)">{t("Description")}</Label>
          <Textarea
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
            rows={3}
          />
        </div>
        {error !== null && (
          <p className="text-xs text-(--err)">
            {t("Not registered")}: {error}
          </p>
        )}
      </div>
    </ResourceEditorSheet>
  );
}
