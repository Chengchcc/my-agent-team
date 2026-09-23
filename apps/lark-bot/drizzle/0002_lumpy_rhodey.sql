CREATE TABLE `run_card` (
	`run_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`lark_chat_id` text NOT NULL,
	`lark_message_id` text,
	`source_message_id` text,
	`status` text DEFAULT 'creating' NOT NULL,
	`accumulated` text DEFAULT '' NOT NULL,
	`tool_count` integer DEFAULT 0 NOT NULL,
	`card_send_failed` integer DEFAULT 0 NOT NULL,
	`card_update_failed` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
