"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

function Section({ title, content }: { title: string; content: string | null }) {
  return (
    <div className="border border-[var(--hairline)] rounded-lg p-8 bg-[var(--canvas)]">
      <h3 className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] mb-4 font-[family-name:var(--font-sans)] font-semibold">
        {title}
      </h3>
      {content === null ? (
        <p className="text-sm text-[var(--mute)]">Not yet configured</p>
      ) : (
        <pre className="text-sm leading-relaxed text-[var(--ink)] whitespace-pre-wrap font-[family-name:var(--font-sans)]">
          {content}
        </pre>
      )}
    </div>
  );
}

export function IdentityPanel({ agentId }: { agentId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["identity", agentId],
    queryFn: () => api.getIdentity(agentId),
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

  return (
    <div className="space-y-4 max-w-2xl">
      <Section title="SOUL" content={data.soul} />
      <Section title="USER" content={data.user} />

      <div className="border border-[var(--hairline)] rounded-lg p-8 bg-[var(--canvas)]">
        <h3 className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] mb-4 font-[family-name:var(--font-sans)] font-semibold">
          Memory ({data.memories.length})
        </h3>
        {data.memories.length === 0 ? (
          <p className="text-sm text-[var(--mute)]">No memories recorded</p>
        ) : (
          <div className="space-y-5">
            {data.memories.map((mem, i) => (
              <div key={i}>
                <p className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] mb-2 font-[family-name:var(--font-sans)] font-semibold">
                  {mem.date}
                </p>
                <pre className="text-sm leading-relaxed text-[var(--ink)] whitespace-pre-wrap font-[family-name:var(--font-sans)]">
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
