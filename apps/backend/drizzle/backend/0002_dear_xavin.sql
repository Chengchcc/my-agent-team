CREATE TABLE `agent_skill_pack` (
	`agent_id` text NOT NULL,
	`pack_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `pack_id`)
);
--> statement-breakpoint
CREATE TABLE `skill_pack` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_url` text,
	`version_ref` text,
	`installed_ref` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_skill_pack_status` ON `skill_pack` (`status`);--> statement-breakpoint
ALTER TABLE `cron_job` ADD `loop_config_path` text;