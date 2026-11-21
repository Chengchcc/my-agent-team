ALTER TABLE `pending_action` ADD `owner` text;--> statement-breakpoint
ALTER TABLE `pending_action` ADD `answered_by` text;--> statement-breakpoint
ALTER TABLE `pending_action` ADD `escalated_at` integer;--> statement-breakpoint
ALTER TABLE `pending_action` ADD `evidence` text;