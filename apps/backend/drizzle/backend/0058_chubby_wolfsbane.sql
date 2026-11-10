CREATE TABLE `proactive_event` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`agent_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`mode` text NOT NULL,
	`outcome` text NOT NULL,
	`chat_id` text,
	`sender_member_id` text,
	`snippet` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_proactive_event_agent` ON `proactive_event` (`agent_id`,`ts`);