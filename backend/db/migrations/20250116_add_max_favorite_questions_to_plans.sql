-- 为 plans 表添加 max_favorite_questions 列
-- 用于定义不同订阅计划的收藏题目数量限制

ALTER TABLE plans ADD COLUMN max_favorite_questions INT NOT NULL DEFAULT 1000 COMMENT '最大收藏题目数量';

-- 配置示例（可选，根据实际需求调整）：
-- 免费计划：1000
-- 标准计划：5000
-- 高级计划：999999（无限）
