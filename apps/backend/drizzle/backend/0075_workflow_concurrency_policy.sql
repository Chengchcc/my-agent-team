-- ADR 0084 D7: drop the unconditional per-workflow single-flight unique index so
-- workflows declaring concurrencyPolicy = "per_requirement" or "allow" can run
-- concurrently across distinct requirements. Concurrency policy is now enforced
-- atomically inside SQLite IMMEDIATE transactions in workflow/adapter-sqlite.ts.
DROP INDEX IF EXISTS `idx_workflow_execution_single_flight`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_execution_wf_req_status` ON `workflow_execution` (`workflow_id`, `requirement_id`, `status`);
