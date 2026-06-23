CREATE TABLE `checkpoint_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`event` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_checkpoint_events_thread` ON `checkpoint_events` (`thread_id`,`id`);--> statement-breakpoint
CREATE TABLE `checkpoint_interrupts` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `checkpoint_messages` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`messages` text NOT NULL,
	`updated_at` integer NOT NULL
);
