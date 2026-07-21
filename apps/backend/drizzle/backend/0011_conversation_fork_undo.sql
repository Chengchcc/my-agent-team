-- 0011: Conversation fork + undo - soft-delete flag on ledger, fork provenance on conversation
ALTER TABLE `conversation_ledger` ADD COLUMN `undone` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation` ADD COLUMN `fork_source` text;--> statement-breakpoint
ALTER TABLE `conversation` ADD COLUMN `fork_from_seq` integer;
