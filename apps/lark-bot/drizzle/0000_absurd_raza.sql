CREATE TABLE `chat_binding` (
	`lark_chat_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`chat_type` text NOT NULL,
	`created_at` integer NOT NULL,
	`pushed_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbound_message` (
	`lark_event_id` text PRIMARY KEY NOT NULL,
	`lark_message_id` text NOT NULL,
	`lark_chat_id` text NOT NULL,
	`conversation_id` text,
	`ledger_seq` integer,
	`status` text DEFAULT 'processing' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inbound_lark_message_id` ON `inbound_message` (`lark_message_id`);--> statement-breakpoint
CREATE TABLE `member_binding` (
	`lark_chat_id` text NOT NULL,
	`lark_open_id` text NOT NULL,
	`member_id` text NOT NULL,
	PRIMARY KEY(`lark_chat_id`, `lark_open_id`)
);
--> statement-breakpoint
CREATE TABLE `message_delivery` (
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`lark_chat_id` text NOT NULL,
	`last_state` text DEFAULT 'streaming' NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `message_id`, `lark_chat_id`)
);
--> statement-breakpoint
CREATE TABLE `run_stream` (
	`run_id` text PRIMARY KEY NOT NULL,
	`lark_chat_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`lark_message_id` text,
	`source_message_id` text,
	`typing_reaction_id` text,
	`typing_status` text DEFAULT 'none' NOT NULL,
	`status` text DEFAULT 'starting' NOT NULL,
	`accumulated` text DEFAULT '' NOT NULL,
	`card_send_failed` integer DEFAULT 0 NOT NULL,
	`card_update_failed` integer DEFAULT 0 NOT NULL,
	`final_ledger_seq` integer,
	`last_error` text,
	`complete_from_ledger` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
