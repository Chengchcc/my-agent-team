CREATE TABLE `reminder` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`created_by` text NOT NULL,
	`text` text NOT NULL,
	`fire_at` integer NOT NULL,
	`fired_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`conversation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_reminder_due` ON `reminder` (`fired_at`,`fire_at`);
--> statement-breakpoint
CREATE INDEX `idx_reminder_conversation` ON `reminder` (`conversation_id`,`created_at`);
