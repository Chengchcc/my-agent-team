CREATE TABLE `loop_budget` (
	`loop_id` text NOT NULL,
	`day` text NOT NULL,
	`spent` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`loop_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `loop_item` (
	`loop_id` text NOT NULL,
	`item_id` text NOT NULL,
	`source` text NOT NULL,
	`summary` text NOT NULL,
	`step` text NOT NULL,
	`attempt` integer NOT NULL,
	`priority` integer NOT NULL,
	`result` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`loop_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_loop_item_step` ON `loop_item` (`loop_id`,`step`);