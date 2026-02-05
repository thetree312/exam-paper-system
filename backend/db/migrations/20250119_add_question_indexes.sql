-- 为快速查询题目添加复合索引
-- 用于 GET /api/questions/{question_id} 端点的性能优化

-- 复合索引：(tenant_id, id)
-- 用于快速查询特定租户的题目
ALTER TABLE questions ADD INDEX idx_questions_tenant_id_id (tenant_id, id);

-- 索引：(user_id, question_id)
-- 用于权限检查和收藏验证
ALTER TABLE question_favorites ADD INDEX idx_question_favorites_user_question (user_id, question_id);
