"use client";

import { FolderOpen, LayoutGrid, List, Search, Upload } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArtifactDetailDialog } from "@/components/ArtifactDetail";
import { ArtifactGalleryCard, type GalleryLayout } from "@/components/ArtifactGalleryCard";
import { fmtBytes } from "@/components/ops/format";
import { Note } from "@/components/ops/kit";
import { QueryState } from "@/components/ops/QueryState";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubTabs } from "@/components/ui/polish";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentList } from "@/features/agents/hooks";
import {
  type ArtifactFilter,
  countArtifactKinds,
  filterArtifacts,
} from "@/features/artifacts/artifact-view";
import { useArtifacts, useUploadArtifact } from "@/features/artifacts/hooks";
import type { ArtifactMeta } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TABS: readonly ArtifactFilter[] = ["all", "document", "change", "visual", "other"];

const TAB_LABEL: Record<ArtifactFilter, string> = {
  all: "All",
  document: "Documents",
  change: "Changes",
  visual: "Visual",
  other: "Other",
};

const GRID_CLASS = "grid grid-cols-1 gap-[18px] sm:grid-cols-2 xl:grid-cols-3";
const LIST_CLASS = "flex flex-col gap-2.5";

type UploadState = "closed" | "open";

function asFilter(key: string): ArtifactFilter {
  const found = TABS.find((candidate) => candidate === key);
  if (found === undefined) return "all";
  return found;
}

/** The registry's upload: a folder, a file, one request. It is the only thing
 *  on this page that writes. */
function UploadDialog({ state, onDone }: { state: UploadState; onDone: () => void }) {
  const uploadArtifact = useUploadArtifact();
  const [folder, setFolder] = useState("");
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [encoding, setEncoding] = useState<"utf8" | "base64">("utf8");
  const ready = folder.trim() !== "" && filename.trim() !== "" && content !== "";
  const url =
    folder.trim() === "" || filename.trim() === ""
      ? ""
      : `artifacts://${folder.trim()}/${filename.trim()}`;

  function pickFile(file: File | undefined): void {
    if (file === undefined) return;
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result ?? "");
      const comma = raw.indexOf(",");
      setFilename(file.name);
      setContent(comma >= 0 ? raw.slice(comma + 1) : raw);
      setEncoding("base64");
    };
    reader.readAsDataURL(file);
  }

  async function upload(): Promise<void> {
    if (!ready) return;
    try {
      await uploadArtifact.mutateAsync({
        folder: folder.trim(),
        filename: filename.trim(),
        content,
        encoding,
      });
      setFolder("");
      setFilename("");
      setContent("");
      setEncoding("utf8");
      onDone();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      toast.error(t("Upload failed: {reason}", { reason }));
    }
  }

  return (
    <Dialog
      open={state === "open"}
      onOpenChange={(next) => {
        if (!next) onDone();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Upload artifact")}</DialogTitle>
          <DialogDescription>
            {t("Pick a file and name a folder. The file is stored under the address shown below.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="artifact-folder" className="text-[11px] text-(--mute)">
              {t("Folder")}
            </Label>
            <Input
              id="artifact-folder"
              className="font-mono"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="report/2026"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="artifact-file" className="text-[11px] text-(--mute)">
              {t("File")}
            </Label>
            <label
              htmlFor="artifact-file"
              className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-(--hairline) bg-[#14191b] px-3 text-xs text-(--body) hover:bg-(--panel2)"
            >
              <Upload className="size-3.5" />
              <span className="truncate">{filename === "" ? t("Choose a file") : filename}</span>
            </label>
            <Input
              id="artifact-file"
              type="file"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
          </div>
          {url !== "" && (
            <p className="font-mono text-[10px] text-(--mute)">
              {t("Address")}: <span className="text-(--body)">{url}</span>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            className="w-full"
            size="sm"
            disabled={!ready || uploadArtifact.isPending}
            onClick={() => void upload()}
          >
            {uploadArtifact.isPending ? t("Uploading…") : t("Upload")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArtifactsView() {
  const [kind, setKind] = useState<ArtifactFilter>("all");
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<GalleryLayout>("grid");
  const [selected, setSelected] = useState<ArtifactMeta | null>(null);
  const [upload, setUpload] = useState<UploadState>("closed");
  // A chat's "Artifacts" link carries the produced-files folder (#65 option C:
  // tool images live here, tied to their conversation, no ledger change).
  const requestedFolder = useSearchParams().get("folder");
  const [folder, setFolder] = useState(requestedFolder ?? "all");
  const artifactsQuery = useArtifacts();
  const { data: agents } = useAgentList();

  const artifacts = artifactsQuery.data?.artifacts ?? [];
  const folders = useMemo(() => {
    const known = new Set<string>();
    for (const artifact of artifacts) {
      if (artifact.folder !== "") known.add(artifact.folder);
    }
    if (requestedFolder !== null) known.add(requestedFolder);
    const sorted = [...known].sort();
    return sorted;
  }, [artifacts, requestedFolder]);

  const scoped = folder === "all" ? artifacts : artifacts.filter((a) => a.folder === folder);
  const counts = countArtifactKinds(scoped);
  const visible = filterArtifacts(scoped, kind, query);
  const totalBytes = scoped.reduce((sum, artifact) => sum + artifact.size, 0);

  function memberName(artifact: ArtifactMeta): string | null {
    const agentId = artifact.source?.agentId;
    if (agentId === undefined) return null;
    const found = agents?.find((member) => member.id === agentId);
    if (found === undefined) return agentId;
    return found.name;
  }

  function clearFilter(): void {
    setKind("all");
    setQuery("");
  }

  const tabs = TABS.map((key) => {
    const item = { key, label: t(TAB_LABEL[key]), count: counts[key] };
    return item;
  });

  return (
    <Page>
      <PageHeader
        kicker={t("Evidence gallery")}
        title={t("Artifacts")}
        description={t(
          "Every result keeps where it came from. From the delivery summary to a fixed revision, “done” becomes something you can look at.",
        )}
        actions={
          <Button size="sm" onClick={() => setUpload("open")}>
            <Upload className="size-3.5" />
            {t("Upload")}
          </Button>
        }
      />
      <PageBody className="space-y-5">
        <SubTabs items={tabs} active={kind} onChange={(key) => setKind(asFilter(key))} />

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <Note>
            {t("{count} files · {size} · each file keeps the member and the run that produced it", {
              count: scoped.length,
              size: fmtBytes(totalBytes),
            })}
          </Note>
          <div className="flex flex-wrap items-center gap-2.5">
            {folders.length > 0 && (
              <Select
                value={folder}
                onValueChange={(value) => {
                  if (typeof value === "string") setFolder(value);
                }}
              >
                <SelectTrigger className="w-44 font-mono text-[11px]" aria-label={t("Folder")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("All folders")}</SelectItem>
                  {folders.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <div className="relative sm:w-72">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-(--faint)" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Filter by file name or address")}
                aria-label={t("Filter by file name or address")}
                className="h-10 pl-9 font-mono text-xs"
              />
            </div>
            <div
              role="group"
              aria-label={t("Layout")}
              className="flex gap-[3px] rounded-[7px] border border-(--hairline) p-[3px]"
            >
              {(["grid", "list"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={layout === option}
                  aria-label={option === "grid" ? t("Grid view") : t("List view")}
                  onClick={() => setLayout(option)}
                  className={cn(
                    "flex min-h-7 items-center rounded-[4px] px-2 text-(--faint) transition-colors",
                    layout === option && "bg-white/[0.043] text-(--ink)",
                  )}
                >
                  {option === "grid" ? (
                    <LayoutGrid className="size-3.5" />
                  ) : (
                    <List className="size-3.5" />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        <QueryState
          query={artifactsQuery}
          empty={(data) => data.artifacts.length === 0}
          emptyTitle={t("No artifacts yet")}
          emptyDescription={t(
            "Artifacts are the files an agent writes during a run, or the ones you upload here. Opening this page produces none.",
          )}
          emptyIcon={FolderOpen}
        >
          {() => (
            <>
              {visible.length === 0 ? (
                <div className="rounded-xl border border-dashed border-(--hairline) px-10 py-[45px] text-center text-xs text-(--mute)">
                  {t("No file matches this filter.")}
                  <div className="mt-1">
                    <Button variant="link" size="sm" onClick={clearFilter}>
                      {t("Clear filter")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className={layout === "grid" ? GRID_CLASS : LIST_CLASS}>
                  {visible.map((artifact) => (
                    <ArtifactGalleryCard
                      key={artifact.url}
                      artifact={artifact}
                      layout={layout}
                      memberName={memberName(artifact)}
                      onOpen={setSelected}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </QueryState>

        <Note>
          {t(
            "A card's preview is the file's own content, read when the card comes into view. The product keeps no check or revision for a stored file, so there is nothing to accept here.",
          )}
        </Note>
      </PageBody>

      <ArtifactDetailDialog artifact={selected} onClose={() => setSelected(null)} />
      <UploadDialog state={upload} onDone={() => setUpload("closed")} />
    </Page>
  );
}

export default function ArtifactsPage() {
  // `useSearchParams` needs a Suspense boundary above it or `next build`
  // refuses to prerender the route (#65: a chat's Artifacts link preselects
  // the produced-files folder).
  return (
    <Suspense fallback={null}>
      <ArtifactsView />
    </Suspense>
  );
}
