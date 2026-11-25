import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { EDITOR_BREAKPOINTS, type EditorWidth, widthOf } from "./editor-layout";
import { isRunning } from "./list-facts";
import { workflowExecutionsQuery } from "./queries";

/** How often a workflow's runs are read again while one is going. */
const EXECUTION_POLL_MS = 5000;

const MD_QUERY = `(min-width: ${EDITOR_BREAKPOINTS.md}px)`;
const XL_QUERY = `(min-width: ${EDITOR_BREAKPOINTS.xl}px)`;

function readEditorWidth(): EditorWidth {
  const viewport = window.innerWidth;
  return widthOf(viewport);
}

function subscribeEditorWidth(onChange: () => void): () => void {
  const queries = [window.matchMedia(MD_QUERY), window.matchMedia(XL_QUERY)];
  for (const query of queries) {
    query.addEventListener("change", onChange);
  }
  return () => {
    for (const query of queries) {
      query.removeEventListener("change", onChange);
    }
  };
}

/** The editor's breakpoint, live. The server cannot see the window: it lays the editor out for a
 *  wide one, and the browser corrects that right after hydration. */
export function useEditorWidth(): EditorWidth {
  return useSyncExternalStore(subscribeEditorWidth, readEditorWidth, () => "wide");
}

/** The runs of one workflow, read again every few seconds while one is going. */
export function useWorkflowExecutions(workflowId: string) {
  return useQuery({
    ...workflowExecutionsQuery(workflowId),
    refetchInterval: (query) => {
      const executions = query.state.data?.executions ?? [];
      if (isRunning(executions)) {
        return EXECUTION_POLL_MS;
      }
      return false;
    },
  });
}
