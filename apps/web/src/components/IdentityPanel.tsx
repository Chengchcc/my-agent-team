"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

function Section({
  title,
  content,
}: {
  title: string;
  content: string | null;
}) {
  return (
    <div className="border border-[var(--border-color)] p-8">
      <h3 className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)] mb-4">
        {title}
      </h3>
      {content === null ? (
        <p className="font-[family-name:var(--font-heading)] text-sm text-[var(--warm-gray-dark)]">
          Not yet configured
        </p>
      ) : (
        <pre className="font-[family-name:var(--font-heading)] text-[15px] leading-relaxed text-[var(--charcoal)] whitespace-pre-wrap">
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
        <div className="h-32 bg-[var(--warm-gray)]" />
        <div className="h-32 bg-[var(--warm-gray)]" />
        <div className="h-20 bg-[var(--warm-gray)]" />
      </div>
    );
  }

  if (!data) {
    return (
      <p className="font-[family-name:var(--font-heading)] text-[var(--warm-gray-dark)]">
        Failed to load identity
      </p>
    );
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <Section title="SOUL" content={data.soul} />
      <Section title="USER" content={data.user} />

      <div className="border border-[var(--border-color)] p-8">
        <h3 className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)] mb-4">
          Memory ({data.memories.length})
        </h3>
        {data.memories.length === 0 ? (
          <p className="font-[family-name:var(--font-heading)] text-sm text-[var(--warm-gray-dark)]">
            No memories recorded
          </p>
        ) : (
          <div className="space-y-5">
            {data.memories.map((mem, i) => (
              <div key={i}>
                <p className="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.15em] text-[var(--warm-gray-dark)] mb-2">
                  {mem.date}
                </p>
                <pre className="font-[family-name:var(--font-heading)] text-[14px] leading-relaxed text-[var(--charcoal)] whitespace-pre-wrap">
                  {mem.content}
                </pre>
                {i < data.memories.length - 1 && (
                  <div className="mt-5 border-t border-[var(--border-color)]" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
