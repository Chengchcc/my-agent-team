"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { useCodingTerminals, useCodingWorkspaces } from "../hooks";
import {
  type CodingNotice,
  type CodingNotifyPref,
  detectTerminalNotices,
  detectWorkspaceRunNotices,
  readNotifyPref,
  snapshotTerminals,
  snapshotWorkspaces,
  subscribeNotifyPref,
  type TerminalSnapshot,
  type WorkspaceSnapshot,
} from "../notifications";

/** Global Herdr-style coding agent notification monitor (ADR 0083 D7).
 *  Mounted once inside AppShell so completion & approval-blocked alerts fire
 *  even when the operator is viewing `/chat`, `/today`, or another OS window. */
export function CodingNotifier() {
  const router = useRouter();
  const terminalsQuery = useCodingTerminals();
  const workspacesQuery = useCodingWorkspaces();
  const [pref, setPref] = useState<CodingNotifyPref>(readNotifyPref);

  const prevTerminalsRef = useRef<Map<string, TerminalSnapshot> | null>(null);
  const prevWorkspacesRef = useRef<Map<string, WorkspaceSnapshot> | null>(null);
  const prefRef = useRef(pref);
  prefRef.current = pref;
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => subscribeNotifyPref(setPref), []);

  useEffect(() => {
    const terms = terminalsQuery.data?.terminals;
    const workspaces = workspacesQuery.data?.workspaces;
    if (!terms) return;

    const emitNotice = (notice: CodingNotice) => {
      if (prefRef.current === "muted") return;
      const title = t(notice.titleKey, notice.titleVars);
      const description = t(notice.bodyKey, notice.bodyVars);
      const actionLabel = notice.kind === "blocked" ? t("Review") : t("Open");

      if (notice.kind === "blocked") {
        toast.warning(title, {
          description,
          duration: 8000,
          action: {
            label: actionLabel,
            onClick: () => routerRef.current.push(notice.href),
          },
        });
      } else {
        toast.success(title, {
          description,
          duration: 6000,
          action: {
            label: actionLabel,
            onClick: () => routerRef.current.push(notice.href),
          },
        });
      }

      // Native OS desktop notification when the browser tab is hidden/backgrounded
      // and the user has granted browser Notification permission.
      if (
        typeof window !== "undefined" &&
        "Notification" in window &&
        window.Notification.permission === "granted" &&
        document.visibilityState === "hidden"
      ) {
        try {
          const n = new window.Notification(title, {
            body: description,
            tag: notice.id,
          });
          n.onclick = () => {
            window.focus();
            routerRef.current.push(notice.href);
            n.close();
          };
        } catch {
          /* ignore platform notification errors */
        }
      }
    };

    const termNotices = detectTerminalNotices(prevTerminalsRef.current, terms);
    prevTerminalsRef.current = snapshotTerminals(terms);

    const notifiedWs = new Set<string>();
    for (const notice of termNotices) {
      if (notice.workspaceId) notifiedWs.add(notice.workspaceId);
      emitNotice(notice);
    }

    if (workspaces) {
      const wsNotices = detectWorkspaceRunNotices(
        prevWorkspacesRef.current,
        workspaces,
        notifiedWs,
      );
      prevWorkspacesRef.current = snapshotWorkspaces(workspaces);
      for (const notice of wsNotices) {
        emitNotice(notice);
      }
    }
  }, [terminalsQuery.data, workspacesQuery.data]);

  return null;
}
