"use client";

import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { ProjectEditorSheet } from "@/components/ProjectEditorSheet";
import { Button } from "@/components/ui/button";
import type { ProjectRow } from "@/lib/api";
import { t } from "@/lib/i18n";

interface ProjectFormProps {
  editProject?: ProjectRow;
  onSuccess?: () => void;
}

/** Where the editor sheet is. It stays mounted while closing, so the sheet can finish its exit
 *  and hand focus back before it is removed. */
type EditorPhase = "closed" | "open" | "closing";

/** Create or edit a project in the editor sheet: the form beside a PA conversation. In edit mode
 *  it opens when `editProject` arrives; the caller removes it once it has closed. */
export function ProjectForm({ editProject, onSuccess }: ProjectFormProps) {
  const [phase, setPhase] = useState<EditorPhase>("closed");

  // Auto-open when editProject changes
  useEffect(() => {
    if (editProject) setPhase("open");
  }, [editProject]);

  function beginClose(): void {
    setPhase("closing");
  }

  return (
    <>
      {/* Edit mode: the editor opens via useEffect — no trigger button needed */}
      {!editProject && (
        <Button size="sm" onClick={() => setPhase("open")}>
          <Plus /> {t("New project")}
        </Button>
      )}

      {phase !== "closed" && (
        <ProjectEditorSheet
          open={phase === "open"}
          project={editProject ?? null}
          onSaved={beginClose}
          onClose={beginClose}
          onClosed={() => {
            setPhase("closed");
            onSuccess?.();
          }}
        />
      )}
    </>
  );
}
