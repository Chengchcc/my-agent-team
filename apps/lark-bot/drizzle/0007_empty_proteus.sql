CREATE TABLE `input_card` (
	`input_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`lark_chat_id` text NOT NULL,
	`card_kit_id` text,
	`lark_message_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
