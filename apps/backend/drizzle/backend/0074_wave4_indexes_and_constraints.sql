-- Wave 4: Hot-path indexes, FK lookup indexes, and workflow single-flight constraint.

-- conversation FK and list lookup indexes
CREATE INDEX IF NOT EXISTS `idx_conversation_parent` ON `conversation` (`parent_conversation_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversation_project` ON `conversation` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversation_current_req` ON `conversation` (`current_requirement_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversation_agent` ON `conversation` (`agent_id`, `created_at`);
--> statement-breakpoint

-- agent_run hot-path indexes (telemetrySummary, /api/agent-runs, child dispatch, requirement view, unnotified recovery)
CREATE INDEX IF NOT EXISTS `idx_agent_run_status_created` ON `agent_run` (`status`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_run_conv_created` ON `agent_run` (`conversation_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_run_agent_created` ON `agent_run` (`agent_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_run_parent` ON `agent_run` (`parent_run_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_run_requirement` ON `agent_run` (`requirement_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_run_unnotified` ON `agent_run` (`status`, `result_notified_at`) WHERE parent_run_id IS NOT NULL AND result_notified_at IS NULL;
--> statement-breakpoint

-- pending_action status + run lookup
CREATE INDEX IF NOT EXISTS `idx_pending_action_status_run` ON `pending_action` (`status`, `run_id`);
--> statement-breakpoint

-- workflow_execution lookup + single-flight partial unique index
CREATE INDEX IF NOT EXISTS `idx_workflow_execution_wf_status` ON `workflow_execution` (`workflow_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_workflow_execution_single_flight` ON `workflow_execution` (`workflow_id`) WHERE status = 'running';
--> statement-breakpoint

-- workflow_node_run status + run_id lookup
CREATE INDEX IF NOT EXISTS `idx_workflow_node_run_exec_status` ON `workflow_node_run` (`execution_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_node_run_run_id` ON `workflow_node_run` (`run_id`);
--> statement-breakpoint

-- branch_input_queue queue claim + run lookup
CREATE INDEX IF NOT EXISTS `idx_queue_status_branch_seq` ON `branch_input_queue` (`status`, `branch_id`, `seq`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_queue_run_id` ON `branch_input_queue` (`run_id`);
--> statement-breakpoint

-- requirement / join-table reverse FK indexes
CREATE INDEX IF NOT EXISTS `idx_requirement_status_updated` ON `requirement` (`status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_requirement_origin_conv` ON `requirement` (`origin_conversation_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conv_req_requirement` ON `conversation_requirement` (`requirement_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workspace_project_status` ON `workspace` (`project_id`, `status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_req_workspace_workspace` ON `requirement_workspace` (`workspace_id`);
--> statement-breakpoint

-- proposal + append-only retention sweep indexes + context entry dedup lookup
CREATE INDEX IF NOT EXISTS `idx_proposal_status_created` ON `proposal` (`status`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_product_tool_call_created` ON `product_tool_call` (`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_run_event_ts` ON `agent_run_event` (`ts`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_execution_event_ts` ON `workflow_execution_event` (`ts`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_context_entry_tree_seq` ON `agent_context_entry` (`tree_id`, `type`, `ledger_seq`);
