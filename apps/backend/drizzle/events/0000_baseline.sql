CREATE TABLE `attempt` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`pid` integer,
	`heartbeat_at` integer,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_attempt_run` ON `attempt` (`run_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `event_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`run_id` text NOT NULL,
	`event` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_event_log_run` ON `event_log` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_event_log_thread` ON `event_log` (`thread_id`,`seq`);--> statement-breakpoint
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
	`run_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`kind` text DEFAULT 'main' NOT NULL,
	`parent_run_id` text,
	`agent_id` text DEFAULT '' NOT NULL,
	`degraded_reason` text,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_run_thread` ON `run` (`thread_id`,"started_at" desc);--> statement-breakpoint
CREATE TABLE `run_ops_event` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`attempt_id` text,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`trace_id` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_run_ops_event_run` ON `run_ops_event` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_run_ops_event_trace` ON `run_ops_event` (`trace_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_run_ops_event_kind` ON `run_ops_event` (`kind`,"ts" desc);--> statement-breakpoint
CREATE TABLE `run_origin` (
	`run_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`source_ledger_seq` integer NOT NULL,
	`agent_member_id` text NOT NULL,
	`surface` text DEFAULT 'web' NOT NULL,
	`trace_id` text NOT NULL,
	`traceparent` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`issue_id` text,
	`from_status` text DEFAULT '' NOT NULL,
	`origin_kind` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_run_origin_idem` ON `run_origin` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_run_origin_trace` ON `run_origin` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_run_origin_issue` ON `run_origin` (`issue_id`);--> statement-breakpoint
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
