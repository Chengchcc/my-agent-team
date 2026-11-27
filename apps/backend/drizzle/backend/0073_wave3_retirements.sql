-- Wave 3 schema retirements:
-- 1) Drop 5 legacy orphan tables left behind by earlier migrations (ADR 0031/0044)
--    plus 2 newly retired tables (conversation_member, proactive_event).
DROP TABLE IF EXISTS `column_config`;
--> statement-breakpoint
DROP TABLE IF EXISTS `deliverable`;
--> statement-breakpoint
DROP TABLE IF EXISTS `issue_event`;
--> statement-breakpoint
DROP TABLE IF EXISTS `issue`;
--> statement-breakpoint
DROP TABLE IF EXISTS `mcp_server_legacy`;
--> statement-breakpoint
DROP TABLE IF EXISTS `conversation_member`;
--> statement-breakpoint
DROP TABLE IF EXISTS `proactive_event`;
--> statement-breakpoint
-- 2) Drop 3 obsolete Loop columns from agent_run and branch_input_queue.
ALTER TABLE `agent_run` DROP COLUMN `workflow`;
--> statement-breakpoint
ALTER TABLE `agent_run` DROP COLUMN `workflow_budget_tokens`;
--> statement-breakpoint
ALTER TABLE `branch_input_queue` DROP COLUMN `workflow_budget_tokens`;
--> statement-breakpoint
-- 3) Normalize legacy backend_kind rows to the single ACP execution rail (ADR 0039/0040).
UPDATE `agent_context_branch` SET `backend_kind` = 'acp' WHERE `backend_kind` != 'acp';
