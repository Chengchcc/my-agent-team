CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`template` text,
	`workspace_path` text NOT NULL,
	`model_provider` text NOT NULL,
	`model_name` text NOT NULL,
	`model_base_url` text,
	`permission_mode` text DEFAULT 'ask' NOT NULL,
	`max_steps` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	`lark_enabled` integer DEFAULT 0 NOT NULL,
	`lark_app_id` text,
	`lark_profile_ref` text,
	`lark_bot_display_name` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_workspacePath_unique` ON `agents` (`workspace_path`);--> statement-breakpoint
CREATE INDEX `idx_agents_archived` ON `agents` (`archived_at`);--> statement-breakpoint
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
CREATE TABLE `column_config` (
	`config_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`agent_id` text NOT NULL,
	`prompt_template` text NOT NULL,
	`approval_posture` text DEFAULT 'auto' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_column_config_proj_status` ON `column_config` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_column_config_project` ON `column_config` (`project_id`);--> statement-breakpoint
CREATE TABLE `control_plane_event` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`span_id` text NOT NULL,
	`attempt_seq` integer,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`trace_id` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_control_plane_event_span` ON `control_plane_event` (`span_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_control_plane_event_trace` ON `control_plane_event` (`trace_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_control_plane_event_kind` ON `control_plane_event` (`kind`,"ts" desc);--> statement-breakpoint
CREATE TABLE `conversation` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`trigger_mode` text DEFAULT 'mention' NOT NULL,
	`hop_count` integer DEFAULT 0 NOT NULL,
	`title` text,
	`origin` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversation_ledger` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_member_id` text NOT NULL,
	`addressed_to` text DEFAULT '[]' NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`ts` integer NOT NULL,
	`span_id` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`conversation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ledger_conv` ON `conversation_ledger` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_ledger_run` ON `conversation_ledger` (`span_id`) WHERE span_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `cron_job` (
	`cron_job_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`agent_id` text NOT NULL,
	`cron_expr` text NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`timeout_ms` integer DEFAULT 0 NOT NULL,
	`max_retries` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cron_job_enabled` ON `cron_job` (`enabled`);--> statement-breakpoint
CREATE TABLE `deliverable` (
	`deliverable_id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`from_status` text NOT NULL,
	`kind` text NOT NULL,
	`fields` text NOT NULL,
	`ref` text,
	`span_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_deliverable_issue` ON `deliverable` (`issue_id`);--> statement-breakpoint
CREATE INDEX `idx_deliverable_issue_kind` ON `deliverable` (`issue_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_deliverable_run_kind` ON `deliverable` (`span_id`,`kind`) WHERE span_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `issue` (
	`issue_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`session_id` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`estimated_completion_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_issue_project` ON `issue` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_issue_status` ON `issue` (`status`);--> statement-breakpoint
CREATE TABLE `issue_event` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_issue_event_issue` ON `issue_event` (`issue_id`,`seq`);--> statement-breakpoint
CREATE TABLE `member` (
	`member_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`agent_id` text,
	`user_ref` text,
	`display_name` text,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `member_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`conversation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_member_conv` ON `member` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `project` (
	`project_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_url` text,
	`default_branch` text,
	`auto_orchestrate` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_name` ON `project` (`name`);--> statement-breakpoint
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
