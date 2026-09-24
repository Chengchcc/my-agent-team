CREATE TABLE `conversation_binding` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`lark_chat_id` text NOT NULL,
	`chat_type` text NOT NULL,
	`chat_mode` text,
	`pushed_seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `topic_binding` (
	`lark_chat_id` text NOT NULL,
	`topic_key` text NOT NULL,
	`conversation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`lark_chat_id`, `topic_key`)
);
--> statement-breakpoint
DROP TABLE `chat_binding`;
