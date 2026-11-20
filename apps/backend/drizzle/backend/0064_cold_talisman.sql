CREATE TABLE `requirement` (
	`requirement_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`goal` text NOT NULL,
	`background` text,
	`constraints` text,
	`expected_deliverables` text,
	`acceptance_criteria` text,
	`status` text DEFAULT 'open' NOT NULL,
	`origin_conversation_id` text,
	`origin_seq` integer,
	`created_by_agent_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agent_run` ADD `requirement_id` text REFERENCES requirement(requirement_id);