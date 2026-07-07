DROP INDEX `idx_span_origin_trace`;--> statement-breakpoint
ALTER TABLE `span_origin` DROP COLUMN `trace_id`;--> statement-breakpoint
ALTER TABLE `span_origin` DROP COLUMN `traceparent`;