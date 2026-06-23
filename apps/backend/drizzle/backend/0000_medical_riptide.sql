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
	`run_id` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`conversation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ledger_conv` ON `conversation_ledger` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_ledger_run` ON `conversation_ledger` (`run_id`) WHERE run_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `deliverable` (
	`deliverable_id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`from_status` text NOT NULL,
	`kind` text NOT NULL,
	`fields` text NOT NULL,
	`ref` text,
	`run_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_deliverable_issue` ON `deliverable` (`issue_id`);--> statement-breakpoint
CREATE INDEX `idx_deliverable_issue_kind` ON `deliverable` (`issue_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_deliverable_run_kind` ON `deliverable` (`run_id`,`kind`) WHERE run_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `issue` (
	`issue_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`thread_id` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`estimated_completion_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_issue_project` ON `issue` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_issue_status` ON `issue` (`status`);--> statement-breakpoint
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
CREATE TABLE `projection_messages` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`messages` text NOT NULL,
	`updated_at` integer NOT NULL
);
