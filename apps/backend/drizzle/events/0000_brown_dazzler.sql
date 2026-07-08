CREATE TABLE `attempt` (
	`span_id` text NOT NULL,
	`seq` integer NOT NULL,
	`pid` integer,
	`heartbeat_at` integer,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	PRIMARY KEY(`span_id`, `seq`),
	FOREIGN KEY (`span_id`) REFERENCES `run`(`span_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_attempt_span` ON `attempt` (`span_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `issue_event` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_issue_event_issue` ON `issue_event` (`issue_id`,`seq`);--> statement-breakpoint
CREATE TABLE `run` (
	`span_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`kind` text DEFAULT 'main' NOT NULL,
	`parent_span_id` text,
	`agent_id` text DEFAULT '' NOT NULL,
	`degraded_reason` text,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_run_session` ON `run` (`session_id`,"started_at" desc);--> statement-breakpoint
CREATE TABLE `run_ops_event` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`span_id` text NOT NULL,
	`attempt_seq` integer,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`trace_id` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_run_ops_event_span` ON `run_ops_event` (`span_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_run_ops_event_trace` ON `run_ops_event` (`trace_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_run_ops_event_kind` ON `run_ops_event` (`kind`,"ts" desc);--> statement-breakpoint
CREATE TABLE `run_origin` (
	`span_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`source_ledger_seq` integer NOT NULL,
	`agent_member_id` text NOT NULL,
	`surface` text DEFAULT 'web' NOT NULL,
	`trace_id` text NOT NULL,
	`traceparent` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`issue_id` text,
	`cron_job_id` text,
	`from_status` text DEFAULT '' NOT NULL,
	`origin_kind` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_run_origin_idem` ON `run_origin` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_run_origin_trace` ON `run_origin` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_run_origin_issue` ON `run_origin` (`issue_id`);--> statement-breakpoint
CREATE INDEX `idx_run_origin_cron` ON `run_origin` (`cron_job_id`);--> statement-breakpoint
CREATE TABLE `runner_health` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`last_seen_at` integer,
	`uptime_ms` integer,
	`active_run_count` integer DEFAULT 0 NOT NULL,
	`active_run_ids` text DEFAULT '[]' NOT NULL,
	`checkpointer_ok` integer DEFAULT 1 NOT NULL,
	`workspace_ok` integer DEFAULT 1 NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `surface_health` (
	`agent_id` text NOT NULL,
	`surface` text NOT NULL,
	`status` text NOT NULL,
	`last_seen_at` integer,
	`payload` text DEFAULT '{}' NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `surface`)
);
