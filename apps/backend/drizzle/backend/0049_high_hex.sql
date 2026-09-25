CREATE TABLE `lark_setup_session` (
	`setup_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`profile_ref` text NOT NULL,
	`bot_display_name` text,
	`brand` text DEFAULT 'feishu' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`url` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_lark_setup_agent` ON `lark_setup_session` (`agent_id`,`created_at`);