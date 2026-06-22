"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

interface SectionProps {
  title: string;
  content: string | null;
  field: "soul" | "user";
  editing: boolean;
  draft: string;
  saving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onChange: (value: string) => void;
}

function Section({
  title,
  content,
  editing,
  draft,
  saving,
  onEdit,
  onCancel,
  onSave,
  onChange,
}: SectionProps) {
  return (
    <div className="border border-[var(--hairline)] rounded-lg p-8 bg-[var(--canvas)]">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] font-[family-name:var(--font-sans)] font-semibold">
          {title}
        </h3>
        {!editing && (
          <Button
            onClick={onEdit}
            variant="ghost"
            size="xs"
          >
            <Pencil size={12} />
            <span className="text-[10px]">Edit</span>
          </Button>
        )}
      </div>
      {editing ? (
        <div className="space-y-3">
          <Textarea
            value={draft}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-[var(--canvas-soft)] border border-[var(--hairline)] rounded-md px-3 py-2 text-sm text-[var(--ink)] font-[family-name:var(--font-mono)] resize-y min-h-[200px] focus:outline-none focus:border-[var(--primary)] transition-colors"
          />
          <div className="flex gap-2">
            <Button onClick={onSave} disabled={saving} size="sm">
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button
              onClick={onCancel}
              disabled={saving}
              variant="outline"
              size="sm"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : content === null ? (
        <p className="text-sm text-[var(--mute)]">Not yet configured</p>
      ) : (
        <pre className="text-sm leading-relaxed text-[var(--ink)] whitespace-pre-wrap font-[family-name:var(--font-sans)] max-h-80 overflow-y-auto">
          {content}
        </pre>
      )}
    </div>
  );
}

export function IdentityPanel({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const [editingField, setEditingField] = useState<"soul" | "user" | null>(null);
  const [draft, setDraft] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["identity", agentId],
    queryFn: () => api.getIdentity(agentId),
  });

  const saveMutation = useMutation({
    mutationFn: (body: { soul?: string; user?: string }) => api.setIdentity(agentId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["identity", agentId] });
      setEditingField(null);
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-32 bg-[var(--canvas-soft)] rounded-lg" />
        <div className="h-32 bg-[var(--canvas-soft)] rounded-lg" />
        <div className="h-20 bg-[var(--canvas-soft)] rounded-lg" />
      </div>
    );
  }

  if (!data) {
    return <p className="text-sm text-[var(--mute)]">Failed to load identity</p>;
  }

  const startEdit = (field: "soul" | "user") => {
    setDraft(data[field] ?? "");
    setEditingField(field);
  };

  const save = () => {
    if (editingField) {
      saveMutation.mutate({ [editingField]: draft });
    }
  };

  const cancel = () => setEditingField(null);

  return (
    <div className="space-y-4 max-w-2xl">
      <Section
        title="SOUL"
        content={data.soul}
        field="soul"
        editing={editingField === "soul"}
        draft={draft}
        saving={saveMutation.isPending}
        onEdit={() => startEdit("soul")}
        onCancel={cancel}
        onSave={save}
        onChange={setDraft}
      />
      <Section
        title="USER"
        content={data.user}
        field="user"
        editing={editingField === "user"}
        draft={draft}
        saving={saveMutation.isPending}
        onEdit={() => startEdit("user")}
        onCancel={cancel}
        onSave={save}
        onChange={setDraft}
      />

      <div className="border border-[var(--hairline)] rounded-lg p-8 bg-[var(--canvas)]">
        <h3 className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] mb-4 font-[family-name:var(--font-sans)] font-semibold">
          Memory ({data.memories.length})
        </h3>
        {data.memories.length === 0 ? (
          <p className="text-sm text-[var(--mute)]">No memories recorded</p>
        ) : (
          <div className="space-y-5 max-h-96 overflow-y-auto">
            {data.memories.map((mem, i) => (
              <div key={i}>
                <p className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] mb-2 font-[family-name:var(--font-sans)] font-semibold">
                  {mem.date}
                </p>
                <pre className="text-sm leading-relaxed text-[var(--ink)] whitespace-pre-wrap font-[family-name:var(--font-sans)] max-h-48 overflow-y-auto">
                  {mem.content}
                </pre>
                {i < data.memories.length - 1 && (
                  <div className="mt-5 border-t border-[var(--hairline)]" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
