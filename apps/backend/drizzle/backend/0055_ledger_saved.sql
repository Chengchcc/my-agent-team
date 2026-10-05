ALTER TABLE `conversation_ledger` ADD `saved` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_ledger_saved` ON `conversation_ledger` (`saved`,`seq`);
