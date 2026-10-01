-- 切面分离（ADR 0040）：成员模型已删（1:1 收敛），addressedTo/sender 路由也已取消，
-- 这两列只剩「写入并往返」，没有任何读者决定事实。账本只保留 canonical 对话事实。
ALTER TABLE `conversation_ledger` DROP COLUMN `sender_member_id`;
--> statement-breakpoint
ALTER TABLE `conversation_ledger` DROP COLUMN `addressed_to`;
