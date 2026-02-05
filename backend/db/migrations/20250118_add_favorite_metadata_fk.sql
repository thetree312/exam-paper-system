-- 添加外键约束和索引（列已在前一个迁移中添加）

-- 添加外键约束
ALTER TABLE question_favorites ADD CONSTRAINT fk_favorites_question_type FOREIGN KEY (question_type_id) REFERENCES question_types(id) ON DELETE SET NULL;
ALTER TABLE question_favorites ADD CONSTRAINT fk_favorites_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL;

-- 添加索引以优化查询
ALTER TABLE question_favorites ADD KEY idx_question_type (question_type_id);
ALTER TABLE question_favorites ADD KEY idx_subject (subject_id);
