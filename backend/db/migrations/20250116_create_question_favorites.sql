-- 创建 question_favorites 表
-- 用于存储用户的题目收藏记录

CREATE TABLE IF NOT EXISTS question_favorites (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  question_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- 防止重复收藏：同一用户不能收藏同一题目两次
  UNIQUE KEY uk_user_question (tenant_id, user_id, question_id),
  
  -- 优化查询性能：按用户和创建时间排序查询
  KEY idx_user_created (tenant_id, user_id, created_at DESC),
  
  -- 外键约束
  CONSTRAINT fk_favorites_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_favorites_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_favorites_question
    FOREIGN KEY (question_id) REFERENCES questions(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
