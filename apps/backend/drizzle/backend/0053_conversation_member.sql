CREATE TABLE `conversation_member` (
	`conversation_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY (`conversation_id`, `agent_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`conversation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_member_agent` ON `conversation_member` (`agent_id`);
--> statement-breakpoint
ALTER TABLE `agent_context_tree` ADD `agent_id` text;
--> statement-breakpoint
DROP INDEX `idx_context_tree_conversation`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_context_tree_conversation_agent` ON `agent_context_tree` (`conversation_id`,`agent_id`);
--> statement-breakpoint
UPDATE `agent_context_tree` SET `agent_id` = (
	SELECT `c`.`agent_id` FROM `conversation` `c`
	WHERE `c`.`conversation_id` = `agent_context_tree`.`conversation_id`
);
--> statement-breakpoint
INSERT INTO `conversation_member` (`conversation_id`, `agent_id`, `added_at`)
SELECT `conversation_id`, `agent_id`, `created_at` FROM `conversation` WHERE `agent_id` IS NOT NULL;
