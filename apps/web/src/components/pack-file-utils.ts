"use client";

import { useQuery } from "@tanstack/react-query";
import { hiddenSegment } from "@/features/skill-packs/pack-model";
import { skillPackFilesQuery } from "@/features/skill-packs/queries";
import { api } from "@/lib/api";

/** A pack file/dir node, shared by skill + knowledge pack browsers. */
export type PackFileNode =
  | { type: "file"; path: string; content: string }
  | { type: "dir"; path: string; entries: Array<{ name: string; type: "dir" | "file" }> };

export type PackKind = "skill";

/** The read-only file surface of a pack. It refuses any path with a hidden segment (`.git/`,
 *  dotfiles): the backend serves them, so this is the only guard. `readable` is false while the
 *  pack is not on disk, and then nothing is requested either. */
export function usePackFiles(
  _kind: PackKind,
  id: string,
  path: string,
  options: { readable: boolean },
) {
  const allowed =
    options.readable && id !== "" && hiddenSegment(path === "" ? "root" : path) === null;
  return useQuery({ ...skillPackFilesQuery(id, path === "" ? undefined : path), enabled: allowed });
}

/** Search hits the reader may open: a hit inside a hidden segment is dropped, never listed. */
export function visibleHits(
  results: ReadonlyArray<{ path: string; line: number; snippet: string }> | undefined,
): Array<{ path: string; line: number; snippet: string }> {
  return (results ?? []).filter((hit) => hiddenSegment(hit.path) === null);
}

export function searchPackFiles(
  _kind: PackKind,
  id: string,
  q: string,
): Promise<{ results?: Array<{ path: string; line: number; snippet: string }>; error?: string }> {
  return api.searchSkillPack(id, q);
}
