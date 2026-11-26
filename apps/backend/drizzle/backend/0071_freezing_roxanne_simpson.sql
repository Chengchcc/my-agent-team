CREATE TABLE `artifact` (
	`url` text PRIMARY KEY NOT NULL,
	`folder` text NOT NULL,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`mime_type` text NOT NULL,
	`encoding` text NOT NULL,
	`sha256` text,
	`run_id` text,
	`conversation_id` text,
	`requirement_id` text,
	`workflow_execution_id` text,
	`agent_id` text,
	`project_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`run_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`conversation_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirement`(`requirement_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workflow_execution_id`) REFERENCES `workflow_execution`(`execution_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`project_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_artifact_folder` ON `artifact` (`folder`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_artifact_requirement` ON `artifact` (`requirement_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_artifact_conversation` ON `artifact` (`conversation_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_artifact_execution` ON `artifact` (`workflow_execution_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_artifact_run` ON `artifact` (`run_id`);--> statement-breakpoint
CREATE TABLE `coding_terminal` (
	`terminal_id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`agent_id` text NOT NULL,
	`workspace_id` text,
	`conversation_id` text,
	`requirement_id` text,
	`cwd` text NOT NULL,
	`title` text NOT NULL,
	`kind` text DEFAULT 'shell' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`project_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`workspace_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`conversation_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirement`(`requirement_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_coding_terminal_conversation` ON `coding_terminal` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_coding_terminal_requirement` ON `coding_terminal` (`requirement_id`);--> statement-breakpoint
CREATE INDEX `idx_coding_terminal_project` ON `coding_terminal` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_coding_terminal_agent` ON `coding_terminal` (`agent_id`);--> statement-breakpoint
ALTER TABLE `workflow_execution` ADD `requirement_id` text REFERENCES requirement(requirement_id);--> statement-breakpoint
ALTER TABLE `workflow_execution` ADD `conversation_id` text REFERENCES conversation(conversation_id);--> statement-breakpoint
ALTER TABLE `workflow_execution` ADD `project_id` text REFERENCES project(project_id);--> statement-breakpoint
CREATE INDEX `idx_workflow_execution_requirement` ON `workflow_execution` (`requirement_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_workflow_execution_conversation` ON `workflow_execution` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_workflow_execution_project` ON `workflow_execution` (`project_id`,`created_at`);