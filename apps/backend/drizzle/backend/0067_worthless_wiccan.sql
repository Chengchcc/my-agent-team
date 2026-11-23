CREATE TABLE `conversation_requirement` (
	`conversation_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `requirement_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`conversation_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirement`(`requirement_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `requirement_workspace` (
	`requirement_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`requirement_id`, `workspace_id`),
	FOREIGN KEY (`requirement_id`) REFERENCES `requirement`(`requirement_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`workspace_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspace` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`base_ref` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`project_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `conversation` ADD `current_requirement_id` text REFERENCES requirement(requirement_id);