CREATE TABLE `span` (
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
CREATE INDEX `idx_span_session` ON `span` (`session_id`,"started_at" desc);--> statement-breakpoint
CREATE TABLE `span_origin` (
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
CREATE UNIQUE INDEX `idx_span_origin_idem` ON `span_origin` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_span_origin_trace` ON `span_origin` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_span_origin_issue` ON `span_origin` (`issue_id`);--> statement-breakpoint
CREATE INDEX `idx_span_origin_cron` ON `span_origin` (`cron_job_id`);--> statement-breakpoint
DROP TABLE `run`;--> statement-breakpoint
DROP TABLE `run_origin`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_attempt` (
	`span_id` text NOT NULL,
	`seq` integer NOT NULL,
	`pid` integer,
	`heartbeat_at` integer,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	PRIMARY KEY(`span_id`, `seq`),
	FOREIGN KEY (`span_id`) REFERENCES `span`(`span_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_attempt`("span_id", "seq", "pid", "heartbeat_at", "started_at", "ended_at") SELECT "span_id", "seq", "pid", "heartbeat_at", "started_at", "ended_at" FROM `attempt`;--> statement-breakpoint
DROP TABLE `attempt`;--> statement-breakpoint
ALTER TABLE `__new_attempt` RENAME TO `attempt`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_attempt_span` ON `attempt` (`span_id`,`started_at`);