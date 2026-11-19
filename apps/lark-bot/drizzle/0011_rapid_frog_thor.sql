CREATE TABLE `access_request` (
	`open_id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text
);
