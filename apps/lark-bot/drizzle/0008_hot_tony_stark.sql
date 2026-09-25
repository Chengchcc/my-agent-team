ALTER TABLE `run_card` ADD `streaming_enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `run_card` ADD `degraded` integer DEFAULT 0 NOT NULL;