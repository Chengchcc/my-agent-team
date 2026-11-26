/** Translate workflow execution errors into human sentences: which node,
 *  what is missing, what to do. Falls back to the raw message. */

import { t } from "@/lib/i18n";

export interface HumanizedError {
  title: string;
  detail?: string;
}

/** Stands in for the node when the trace names none. */
const UNKNOWN_NODE = "?";

export function humanizeWorkflowError(
  error: string | undefined,
  nodeRuns: Array<{ nodeId: string; status: string; error?: string }>,
): HumanizedError | null {
  if (!error) return null;

  const m = /node (\S+) missing required input artifact: (\S+)/.exec(error);
  if (m) {
    return {
      title: t("Artifact required by node {node} does not exist", { node: m[1] ?? "" }),
      detail: t(
        "You must provide {artifact} before running. Upload it on the Artifacts page, or pick the correct address in the input field at run time.",
        { artifact: m[2] ?? "" },
      ),
    };
  }

  const a = /workflow (\S+) input artifact (\S+) does not exist: (\S+)/.exec(error);
  if (a) {
    return {
      title: t("Input artifact {artifact} does not exist", { artifact: a[2] ?? "" }),
      detail: t(
        "The {address} provided for this run was not found in the artifact store. Upload it first, or check the address spelling.",
        { address: a[3] ?? "" },
      ),
    };
  }

  const o = /node (\S+) missing required output artifact: (\S+)/.exec(error);
  if (o) {
    return {
      title: t("Node {node} did not produce the declared artifact", { node: o[1] ?? "" }),
      detail: t(
        "This node promised to produce {artifact}, but it does not exist after execution. The agent needs to call artifact_upload to upload the artifact before the workflow can continue.",
        { artifact: o[2] ?? "" },
      ),
    };
  }

  const s = /node (\S+) output invalid: (.+)/.exec(error);
  if (s) {
    return {
      title: t("Node {node} output format is invalid", { node: s[1] ?? "" }),
      detail: t(
        "{reason}. Relax the output declaration in the node properties, or adjust the prompt so the agent outputs as required, then retry.",
        { reason: s[2] ?? "" },
      ),
    };
  }

  const sc = /script failed \(exit \d+\): (.+)/s.exec(error);
  if (sc) {
    const failed = nodeRuns.find((r) => r.status === "failed");
    return {
      title: t("Script node {node} failed", { node: failed?.nodeId ?? UNKNOWN_NODE }),
      detail: sc[1]!.split("\n")[0]!.slice(0, 200),
    };
  }

  const ag = /agent run (\S+) ended (failed|aborted|timeout|commit_failed)/.exec(error);
  if (ag) {
    const failed = nodeRuns.find((r) => r.status === "failed");
    const node = failed?.nodeId ?? UNKNOWN_NODE;
    return {
      title:
        ag[2] === "timeout"
          ? t("Agent node {node} timed out", { node })
          : t("Agent node {node} failed", { node }),
      detail: t(
        "Expand the agent conversation in the Trace view to see what happened; or increase retries and run again.",
      ),
    };
  }

  if (error.includes("stuck: no ready nodes")) {
    return {
      title: t("Workflow stuck: no runnable next step"),
      detail: t(
        "Usually this means no edge condition matched. Check the condition expressions at the branch against the node outputs.",
      ),
    };
  }

  return { title: error.slice(0, 160) };
}
