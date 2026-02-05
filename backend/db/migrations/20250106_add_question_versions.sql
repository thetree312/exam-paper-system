-- Adds question versions JSON column for paginated card history.
-- Run once against the database configured in backend/.env.

USE `exam_paper`;

SET @table_schema := DATABASE();

SET @missing_versions :=
  (SELECT COUNT(*) = 0
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @table_schema
      AND TABLE_NAME = 'questions'
      AND COLUMN_NAME = 'versions');

SET @sql := IF(
  @missing_versions,
  'ALTER TABLE `questions` ADD COLUMN `versions` JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER `grading_confidence`',
  'SELECT "versions already exists"'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
