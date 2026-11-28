import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Message } from "@chengchenccc/message";
import {
  buildSummarizationRequest,
  collectCommands,
  collectFileOperations,
  collectQa,
  renderCommands,
  renderFileOperations,
  renderQa,
  upsertStateBlocks,
} from "../../core/runtime/compaction-prompt.js";
import { summaryMaxTokens } from "../../core/runtime/run-runtime.js";
import {
  appendSessionCompaction,
  deleteSession,
  diffWorkspaceAgainstTree,
  forkSession,
  listAllSessions,
  listSessions,
  renameSession,
  renderSessionMarkdown,
  restoreCheckpointTree,
  restoreFileFromTree,
  sessionDirFor,
} from "../../core/session/session-file.js";
import { resolveSession } from "../../core/session/session-loop.js";
import { readTodoFile, todoFilePath } from "../../core/tools/todo-store.js";
import type { CommandDef, TuiSessionContext } from "./tui-commands.js";
import { sessionRow } from "./tui-format.js";
import { hydrateTranscript } from "./view-state.js";

export function buildSessionCommands(ctx: TuiSessionContext): CommandDef[] {
  return [
    {
      name: "session",
      description: "show, rename, or delete sessions",
      argumentHint: "[rename <id> <title> | delete <id>]",
      group: "session",
      live: true,
      run: (args) => {
        const trimmed = args.trim();
        if (trimmed.startsWith("rename ")) {
          const rest = trimmed.slice("rename ".length).trim();
          const space = rest.indexOf(" ");
          if (space <= 0) {
            ctx.pushStatus("usage: /session rename <session-id> <title>");
            return;
          }
          const id = rest.slice(0, space).trim();
          const title = rest.slice(space + 1).trim();
          if (!title) {
            ctx.pushStatus("usage: /session rename <session-id> <title>");
            return;
          }
          const dir = process.env.OMA_SESSION_DIR ?? sessionDirFor(ctx.opts.workspaceRoot);
          if (!renameSession(id, title, dir)) ctx.pushStatus(`no session: ${id}`);
          else {
            if (id === ctx.session.sessionId) {
              ctx.sessionTitle = title;
              ctx.io.setHeader?.({ model: ctx.modelId, sessionId: ctx.session.sessionId, title });
            }
            ctx.pushStatus(`renamed ${id} → ${title}`);
          }
          return;
        }
        if (trimmed.startsWith("delete ")) {
          const id = trimmed.slice("delete ".length).trim();
          if (!id) {
            ctx.pushStatus("usage: /session delete <session-id>");
            return;
          }
          if (id === ctx.session.sessionId) {
            ctx.pushStatus("cannot delete the active session");
            return;
          }
          const dir = process.env.OMA_SESSION_DIR ?? sessionDirFor(ctx.opts.workspaceRoot);
          if (!deleteSession(id, dir)) {
            ctx.pushStatus(`no session: ${id}`);
          } else {
            try {
              rmSync(todoFilePath(ctx.opts.workspaceRoot, id), { force: true });
            } catch {
              /* best effort */
            }
            ctx.pushStatus(`deleted session: ${id}`);
          }
          return;
        }
        ctx.pushStatus(
          `session: ${ctx.session.sessionId}${ctx.sessionTitle ? ` — ${ctx.sessionTitle}` : ""}`,
        );
      },
    },
    {
      name: "diff",
      description: "inspect workspace changes or restore a file from session baseline",
      argumentHint: "[<file> | restore <file>]",
      group: "session",
      live: true,
      run: (args) => {
        const baseline = ctx.checkpoints?.[0]?.treeSha;
        const trimmed = args.trim();
        if (trimmed.startsWith("restore ")) {
          const relPath = trimmed.slice("restore ".length).trim();
          if (!relPath) {
            ctx.pushStatus("usage: /diff restore <relative-file-path>");
            return;
          }
          if (!baseline) {
            ctx.pushStatus("no session checkpoint available yet (requires a git workspace)");
            return;
          }
          const res = restoreFileFromTree(ctx.opts.workspaceRoot, baseline, relPath);
          if (!res.ok) {
            ctx.pushStatus(`restore failed: ${res.error ?? "unknown error"}`);
            return;
          }
          ctx.pushStatus(`${res.action === "removed" ? "removed" : "restored"} ${relPath}`);
          return;
        }
        const filePath = trimmed || undefined;
        const res = diffWorkspaceAgainstTree(ctx.opts.workspaceRoot, baseline, filePath);
        if (!res.ok) {
          ctx.pushStatus(`diff unavailable: ${res.error ?? "not a git repository"}`);
          return;
        }
        if (!res.stat && !res.patch) {
          ctx.pushStatus("working tree clean (no changes since session baseline)");
          return;
        }
        const out: string[] = [];
        if (res.stat) out.push(...res.stat.split("\n"));
        if (res.patch) {
          const patchLines = res.patch.split("\n");
          out.push(...patchLines.slice(0, 120));
          if (patchLines.length > 120) {
            out.push(`… (+${patchLines.length - 120} more lines)`);
          }
        }
        ctx.pushStatus(out);
      },
    },
    {
      name: "rewind",
      description: "rewind conversation and optionally restore files to an earlier turn",
      argumentHint: "[<turn>]",
      group: "session",
      run: async (args) => {
        const checkpoints = ctx.checkpoints ?? [];
        if (checkpoints.length === 0) {
          ctx.pushStatus(
            "no file checkpoints recorded yet (requires a git workspace + at least 1 turn)",
          );
          return;
        }
        let target: (typeof checkpoints)[number] | undefined;
        const parsed = Number.parseInt(args.trim(), 10);
        if (args.trim() && Number.isInteger(parsed) && parsed >= 1) {
          target = checkpoints.find((c) => c.turn === parsed);
          if (!target) {
            ctx.pushStatus(`no checkpoint for turn #${parsed}`);
            return;
          }
        } else if (ctx.io.pickOption) {
          const picked = await ctx.io.pickOption(
            "Rewind to Checkpoint",
            [...checkpoints].reverse().map((c) => ({
              value: String(c.turn),
              label: `Turn #${c.turn}`,
              description: `${c.prompt || "(turn)"} · ${c.treeSha.slice(0, 7)}`,
            })),
          );
          if (!picked) {
            ctx.pushStatus("rewind cancelled");
            return;
          }
          target = checkpoints.find((c) => String(c.turn) === picked);
        } else {
          ctx.pushStatus([
            "usage: /rewind <turn>",
            ...checkpoints.map((c) => `  #${c.turn}  ${c.treeSha.slice(0, 7)}  ${c.prompt}`),
          ]);
          return;
        }
        if (!target) return;

        let restoreFiles = true;
        if (ctx.io.pickOption) {
          const mode = await ctx.io.pickOption(`Rewind to Turn #${target.turn}`, [
            {
              value: "both",
              label: "Conversation + files",
              description: "restore workspace files to before this turn and rewind transcript",
            },
            {
              value: "chat",
              label: "Conversation only",
              description: "keep current file edits, rewind transcript only",
            },
          ]);
          if (!mode) {
            ctx.pushStatus("rewind cancelled");
            return;
          }
          restoreFiles = mode === "both";
        }

        if (restoreFiles) {
          const restored = restoreCheckpointTree(ctx.opts.workspaceRoot, target.treeSha);
          if (!restored.ok) {
            ctx.pushStatus(`rewind failed restoring files: ${restored.error ?? "unknown error"}`);
            return;
          }
        }
        if (target.turn <= 1) {
          const workspaceSessionDir =
            process.env.OMA_SESSION_DIR ?? sessionDirFor(ctx.opts.workspaceRoot);
          ctx.session = resolveSession(undefined, workspaceSessionDir);
          ctx.sessionTitle = undefined;
        } else {
          const newId = forkSession(ctx.session.sessionId, target.turn - 1, ctx.session.dir);
          if (newId) {
            ctx.session = resolveSession(newId, ctx.session.dir);
            ctx.sessionTitle = undefined;
          }
        }
        ctx.state.todoItems = readTodoFile(ctx.opts.workspaceRoot, ctx.session.sessionId);
        hydrateTranscript(ctx.state, ctx.session.messages);
        ctx.reloadSessionDrivers?.();
        ctx.refreshStatusChrome?.();
        ctx.pushStatus(
          `rewound to before turn #${target.turn}${restoreFiles ? " (files + conversation restored)" : " (conversation only)"}`,
        );
      },
    },
    {
      name: "export",
      description: "export the current session transcript as Markdown",
      argumentHint: "[<path>]",
      group: "session",
      live: true,
      run: (args) => {
        if (ctx.session.messages.length === 0) {
          ctx.pushStatus("nothing to export yet");
          return;
        }
        const rawPath = args.trim();
        const targetPath = rawPath
          ? isAbsolute(rawPath)
            ? rawPath
            : resolve(ctx.opts.workspaceRoot, rawPath)
          : join(
              ctx.opts.workspaceRoot,
              ".oma",
              "exports",
              `session-${ctx.session.sessionId.slice(0, 8)}.md`,
            );
        const md = renderSessionMarkdown({
          sessionId: ctx.session.sessionId,
          title: ctx.sessionTitle,
          modelId: ctx.modelId,
          workspaceRoot: ctx.opts.workspaceRoot,
          messages: ctx.session.messages,
        });
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, md, "utf8");
        ctx.pushStatus(
          `exported session (${ctx.session.messages.length} messages) → ${targetPath}`,
        );
      },
    },
    {
      name: "resume",
      description: "list/resume sessions (all = every workspace)",
      argumentHint: "<session>",
      group: "session",
      run: async (args) => {
        // "all" = cross-workspace listing (pi's session selector "all"
        // scope); any other arg is an id/prefix within this workspace.
        const all = args === "all";
        const sessions = all ? listAllSessions() : listSessions(ctx.opts.workspaceRoot);
        if (sessions.length === 0) {
          ctx.pushStatus(all ? "no sessions in any workspace" : "no saved sessions");
          return;
        }
        if (!args || all) {
          // Interactive overlay when the ctx.io supports it; text list otherwise.
          if (ctx.io.pickSession) {
            const picked = await ctx.io.pickSession(sessions.slice(0, 100), ctx.session.sessionId);
            if (!picked) {
              ctx.pushStatus("resume cancelled");
              return;
            }
            const summary = sessions.find((s) => s.id === picked);
            const dir =
              summary?.dir ??
              (all && summary?.workspace ? sessionDirFor(summary.workspace) : undefined);
            ctx.session = resolveSession(picked, dir);
            ctx.sessionTitle = summary?.title;
            ctx.state.todoItems = readTodoFile(ctx.opts.workspaceRoot, ctx.session.sessionId);
            hydrateTranscript(ctx.state, ctx.session.messages);
            ctx.reloadSessionDrivers?.();
            ctx.io.setHeader?.({
              model: ctx.modelId,
              sessionId: ctx.session.sessionId,
              title: ctx.sessionTitle,
            });
            ctx.pushStatus(
              `resumed session: ${ctx.session.sessionId} (${ctx.session.messages.length} messages)`,
            );
            return;
          }
          ctx.pushStatus(
            sessions.slice(0, 50).map((s) => {
              // Same row shape as the picker: the id stays in the text listing
              // because this fallback is where /resume <prefix> is typed from.
              const { label, description } = sessionRow(s, undefined, {
                currentWorkspace: ctx.opts.workspaceRoot,
              });
              return `${label}  ${s.id}  ${description}`;
            }),
          );
          return;
        }
        const matches = sessions.filter((s) => s.id.startsWith(args));
        if (matches.length === 0) {
          ctx.pushStatus(`no session matches: ${args} (see /resume for the list)`);
          return;
        }
        if (matches.length > 1) {
          ctx.pushStatus(matches.map((s) => `${s.id}  ${s.title ?? s.preview}`));
          return;
        }
        ctx.session = resolveSession(matches[0]!.id, matches[0]!.dir);
        ctx.sessionTitle = matches[0]!.title;
        ctx.state.todoItems = readTodoFile(ctx.opts.workspaceRoot, ctx.session.sessionId);
        hydrateTranscript(ctx.state, ctx.session.messages);
        ctx.reloadSessionDrivers?.();
        ctx.io.setHeader?.({
          model: ctx.modelId,
          sessionId: ctx.session.sessionId,
          title: ctx.sessionTitle,
        });
        ctx.pushStatus(
          `resumed session: ${ctx.session.sessionId} (${ctx.session.messages.length} messages)`,
        );
      },
    },
    {
      name: "new",
      description: "start a fresh session (clears the transcript)",
      argumentHint: "[--keep-loop]",
      group: "session",
      run: (args) => {
        // --keep-loop is how a restarting loop (reset / build) survives the
        // fresh session it asked for; without it a loop switch would end the
        // loop that requested it.
        const keepLoop = args.trim() === "--keep-loop";
        const workspaceSessionDir =
          process.env.OMA_SESSION_DIR ?? sessionDirFor(ctx.opts.workspaceRoot);
        ctx.session = resolveSession(undefined, workspaceSessionDir);
        ctx.sessionTitle = undefined;
        // Todo is session-scoped: a fresh session starts with an empty
        // list — the previous session's items must not leak into the
        // chrome or the next run's Meta.
        ctx.state.todoItems = readTodoFile(ctx.opts.workspaceRoot, ctx.session.sessionId);
        hydrateTranscript(ctx.state, ctx.session.messages);
        // A fresh session starts with no goal and no loop: otherwise the
        // previous session's goal would keep driving turns and its accounting
        // would land on the wrong conversation.
        ctx.reloadSessionDrivers?.({ keepLoop });
        ctx.io.setHeader?.({
          model: ctx.modelId,
          sessionId: ctx.session.sessionId,
          title: ctx.sessionTitle,
        });
        ctx.pushStatus(`new session: ${ctx.session.sessionId}`);
      },
    },
    {
      name: "compact",
      description: "summarize the session so far and fold the transcript",
      group: "session",
      run: async () => {
        const msgs = ctx.session.messages;
        if (msgs.length < 4) {
          ctx.pushStatus("nothing to compact yet");
          return;
        }
        ctx.pushStatus("compacting…");
        ctx.io.render(ctx.state);
        const catalog = await ctx.opts.modelRuntime.getCatalog();
        const canonical =
          ctx.modelId ??
          (() => {
            const first = catalog.models.find((m) => m.available !== false);
            return first ? `${first.providerId}/${first.modelId}` : undefined;
          })();
        if (!canonical) {
          ctx.pushStatus("compact: no available model");
          return;
        }
        const slash = canonical.indexOf("/");
        const providerId = canonical.slice(0, slash);
        const modelId = canonical.slice(slash + 1);
        const modelMeta = catalog.models.find(
          (m) => m.providerId === providerId && m.modelId === modelId,
        );
        try {
          const typedMsgs = msgs as unknown as Message[];
          const prevSummaryMatch =
            typedMsgs[0]?.role === "user" && typeof typedMsgs[0].text === "string"
              ? typedMsgs[0].text.match(
                  /^<previous_session_summary>\n([\s\S]*?)\n<\/previous_session_summary>$/,
                )
              : null;
          const previousSummary = prevSummaryMatch?.[1];
          const toSummarize = previousSummary !== undefined ? typedMsgs.slice(1) : typedMsgs;
          const summaryMessages = buildSummarizationRequest(toSummarize, {
            ...(previousSummary !== undefined ? { previousSummary } : {}),
          });
          const chunks: string[] = [];
          const signal = AbortSignal.timeout(120_000);
          for await (const chunk of ctx.opts.modelRuntime.stream(
            providerId,
            modelId,
            summaryMessages,
            {
              signal,
              ...(modelMeta?.maxOutputTokens
                ? { maxTokens: summaryMaxTokens(modelMeta.maxOutputTokens) }
                : {}),
            },
          )) {
            if (chunk.delta?.type === "text") chunks.push(chunk.delta.text);
          }
          const rawSummary = chunks.join("").trim();
          if (!rawSummary) {
            ctx.pushStatus("compact: model returned an empty summary");
            return;
          }
          const stateBlocks = [
            renderFileOperations(collectFileOperations(typedMsgs)),
            renderCommands(collectCommands(typedMsgs)),
            renderQa(collectQa(typedMsgs)),
          ]
            .filter((block) => block !== "")
            .join("\n\n");
          const summary = upsertStateBlocks(rawSummary, stateBlocks);
          // /compact folds the in-memory transcript to this summary, so the
          // event really does replace everything before it.
          appendSessionCompaction(ctx.session.sessionId, summary, ctx.session.dir, true);
          // Mirror the file-folding shape (loadSessionMessages) in memory so
          // the live transcript and a later resume agree.
          ctx.session.messages = [
            {
              role: "user",
              text: `<previous_session_summary>\n${summary}\n</previous_session_summary>`,
            },
          ];
          ctx.state.runs.length = 0;
          ctx.refreshSessionContext?.();
          ctx.pushStatus(`compacted: ${summary.slice(0, 160)}${summary.length > 160 ? "…" : ""}`);
          ctx.io.render(ctx.state);
        } catch (err) {
          ctx.pushStatus(`compact failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: "clear",
      description: "clear the transcript view (keeps the session)",
      group: "view",
      run: () => {
        ctx.state.runs.length = 0;
      },
    },
    {
      name: "fork",
      description: "fork the session from an earlier user message",
      argumentHint: "<n>",
      group: "session",
      run: async (args) => {
        // Anchors: user-role messages in the live transcript. Compaction
        // summaries carry role user too; they are legitimate fork points.
        const anchors = ctx.session.messages
          .filter((m) => (m as { role?: string }).role === "user")
          .map((m) => String((m as { text?: string }).text ?? ""));
        if (anchors.length === 0) {
          ctx.pushStatus("no user messages to fork from yet");
          return;
        }
        let ordinal: number | undefined;
        const parsed = Number(args);
        if (args && Number.isInteger(parsed) && parsed >= 1) {
          ordinal = parsed;
        } else if (ctx.io.pickForkPoint) {
          const picked = await ctx.io.pickForkPoint(
            anchors.map((text, i) => ({
              ordinal: i + 1,
              text: text.replace(/\s+/g, " ").slice(0, 60),
            })),
          );
          if (picked === null) {
            ctx.pushStatus("fork cancelled");
            return;
          }
          ordinal = picked;
        } else {
          ctx.pushStatus("usage: /fork <n> (n = user message number)");
          return;
        }
        const parentId = ctx.session.sessionId;
        const newId = forkSession(parentId, ordinal, ctx.session.dir);
        if (newId === null) {
          ctx.pushStatus(`cannot fork: no user message #${ordinal}`);
          return;
        }
        ctx.session = resolveSession(newId, ctx.session.dir);
        ctx.sessionTitle = undefined;
        ctx.state.todoItems = readTodoFile(ctx.opts.workspaceRoot, ctx.session.sessionId);
        hydrateTranscript(ctx.state, ctx.session.messages);
        ctx.reloadSessionDrivers?.();
        ctx.io.setHeader?.({ model: ctx.modelId, sessionId: ctx.session.sessionId });
        ctx.pushStatus(
          `forked ${parentId.slice(0, 8)} @ msg ${ordinal} -> ${newId.slice(0, 8)} ` +
            `(${ctx.session.messages.length} messages)`,
        );
      },
    },
    {
      name: "rename",
      description: "rename a session's title",
      argumentHint: "<session> <title>",
      group: "session",
      hidden: true,
      run: (args) => {
        const space = args.indexOf(" ");
        if (space <= 0) {
          ctx.pushStatus("usage: /rename <session-id> <title>");
          return;
        }
        const id = args.slice(0, space).trim();
        const title = args.slice(space + 1).trim();
        if (!title) {
          ctx.pushStatus("usage: /rename <session-id> <title>");
          return;
        }
        const dir = process.env.OMA_SESSION_DIR ?? sessionDirFor(ctx.opts.workspaceRoot);
        if (!renameSession(id, title, dir)) ctx.pushStatus(`no session: ${id}`);
        else {
          if (id === ctx.session.sessionId) {
            ctx.sessionTitle = title;
            ctx.io.setHeader?.({ model: ctx.modelId, sessionId: ctx.session.sessionId, title });
          }
          ctx.pushStatus(`renamed ${id} → ${title}`);
        }
      },
    },
    {
      name: "delete",
      description: "delete a session file",
      argumentHint: "<session>",
      group: "session",
      hidden: true,
      run: (args) => {
        if (!args) {
          ctx.pushStatus("usage: /delete <session-id>");
          return;
        }
        if (args === ctx.session.sessionId) {
          ctx.pushStatus("cannot delete the active session");
          return;
        }
        const dir = process.env.OMA_SESSION_DIR ?? sessionDirFor(ctx.opts.workspaceRoot);
        if (!deleteSession(args, dir)) {
          ctx.pushStatus(`no session: ${args}`);
        } else {
          // The session's scoped todo file dies with it.
          try {
            rmSync(todoFilePath(ctx.opts.workspaceRoot, args), { force: true });
          } catch {
            /* best effort */
          }
          ctx.pushStatus(`deleted session: ${args}`);
        }
      },
    },
  ];
}
