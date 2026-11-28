-- ADR 0085 D5 & D7: Functional evaluation runs/results and production run feedback.
CREATE TABLE IF NOT EXISTS `eval_run` (
  `eval_run_id` text PRIMARY KEY NOT NULL,
  `suite_id` text NOT NULL,
  `suite_commit` text,
  `label` text,
  `target_kind` text NOT NULL,
  `target_ref` text NOT NULL,
  `model_ref` text,
  `status` text DEFAULT 'running' NOT NULL,
  `trials` integer DEFAULT 1 NOT NULL,
  `concurrency` integer DEFAULT 2 NOT NULL,
  `max_total_cost_usd` text,
  `summary_json` text,
  `error` text,
  `created_at` integer NOT NULL,
  `terminal_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_eval_run_suite_created` ON `eval_run` (`suite_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_eval_run_target` ON `eval_run` (`target_kind`, `target_ref`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_eval_run_status` ON `eval_run` (`status`, `created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `eval_case_result` (
  `result_id` text PRIMARY KEY NOT NULL,
  `eval_run_id` text NOT NULL,
  `case_id` text NOT NULL,
  `trial_index` integer DEFAULT 0 NOT NULL,
  `run_id` text,
  `workflow_execution_id` text,
  `passed` integer DEFAULT 0 NOT NULL,
  `score` text DEFAULT '0' NOT NULL,
  `grader_results_json` text DEFAULT '[]' NOT NULL,
  `active_duration_ms` integer,
  `tool_calls` integer DEFAULT 0 NOT NULL,
  `input_tokens` integer DEFAULT 0 NOT NULL,
  `output_tokens` integer DEFAULT 0 NOT NULL,
  `cache_read_tokens` integer DEFAULT 0 NOT NULL,
  `cost_usd` text DEFAULT '0' NOT NULL,
  `error` text,
  `created_at` integer NOT NULL,
  `terminal_at` integer,
  FOREIGN KEY (`eval_run_id`) REFERENCES `eval_run`(`eval_run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_eval_case_result_run` ON `eval_case_result` (`eval_run_id`, `case_id`, `trial_index`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_eval_case_result_agent_run` ON `eval_case_result` (`run_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `run_feedback` (
  `feedback_id` text PRIMARY KEY NOT NULL,
  `run_id` text,
  `workflow_execution_id` text,
  `rating` text NOT NULL,
  `tags_json` text DEFAULT '[]' NOT NULL,
  `note` text,
  `promoted_suite_id` text,
  `promoted_case_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_run_feedback_run` ON `run_feedback` (`run_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_run_feedback_exec` ON `run_feedback` (`workflow_execution_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_run_feedback_created` ON `run_feedback` (`created_at`);
