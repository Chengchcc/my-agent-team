CREATE TABLE `comment_binding` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`file_token` text NOT NULL,
	`file_type` text NOT NULL,
	`comment_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_comment_binding_line` ON `comment_binding` (`file_token`,`comment_id`);
--> statement-breakpoint
CREATE TABLE `comment_subscription` (
	`file_token` text PRIMARY KEY NOT NULL,
	`file_type` text NOT NULL,
	`subscribed_at` integer NOT NULL
);
