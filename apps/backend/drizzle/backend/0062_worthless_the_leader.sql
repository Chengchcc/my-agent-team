CREATE TABLE `answer_draft` (
	`run_id` text NOT NULL,
	`call_id` text NOT NULL,
	`body` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `call_id`)
);
--> statement-breakpoint
ALTER TABLE `agent_run` ADD `result_seen_at` integer;--> statement-breakpoint
ALTER TABLE `pending_action` ADD `seen_at` integer;