-- 2025-01-20: 扩展 agent_sessions 表以支持会话元数据
-- - title: 可选会话标题
-- - last_message_preview: 最近一条消息摘要
-- - message_count: 消息数量统计
-- - archived: 归档标记
-- - deleted_at: 软删除时间戳

ALTER TABLE agent_sessions
    ADD COLUMN title VARCHAR(255) NULL AFTER view_id,
    ADD COLUMN last_message_preview MEDIUMTEXT NULL AFTER title,
    ADD COLUMN message_count INT NOT NULL DEFAULT 0 AFTER last_message_preview,
    ADD COLUMN archived TINYINT(1) NOT NULL DEFAULT 0 AFTER status,
    ADD COLUMN deleted_at DATETIME NULL AFTER updated_at;
