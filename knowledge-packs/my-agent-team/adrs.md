# Key ADRs

完整索引与状态见 `docs/adr/README.md`；本文件只列经常要查的几条。

- ADR 0020: agent.yml is the portable agent config single source; DB keeps only
  the anchor row plus a materialized cache. Identity files SOUL.md and USER.md
  are frozen into each run snapshot.
- ADR 0022: MCP servers and knowledge packs are global pools with per-agent
  switches in agent.yml. The workspace bridge merges enabled servers into
  .mcp.json and symlinks assigned knowledge packs into the workspace.
- ADR 0023: projects attach to agents and materialize as git worktrees under the
  agent workspace. The same MCP + product-tools bridge is written into worktree
  roots.
- Phase 5: run-centric rewrite. The product adapter spawns oma --mode rpc
  per Product Run; the backend persists frozen run snapshots and per-input config
  snapshots. Note: the boot recovery path exists in code but is not called on
  startup today (see docs/roadmap.md).
- Phase 6: clean cutover. Legacy execution schema (span/attempt/control_plane_event)
  dropped; Agent Run is the only product execution identity.

## Run verdict

Workflow 的 human 节点与 agent 节点的验收不看模型自己写的结论文本，而是看 committed run 里的记录：节点输出要过 outputSchema，工具失败以 tool_result 的 is_error 为准。
