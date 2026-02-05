-- Adds question group_id column to group related questions into a single card.
-- Run once against the database configured in backend/.env.

USE `exam_paper`;

SET @table_schema := DATABASE();

SET @missing_group_id :=
  (SELECT COUNT(*) = 0
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @table_schema
      AND TABLE_NAME = 'questions'
      AND COLUMN_NAME = 'group_id');

SET @sql := IF(
  @missing_group_id,
  'ALTER TABLE `questions` ADD COLUMN `group_id` BIGINT UNSIGNED NULL AFTER `document_id`',
  'SELECT "group_id already exists"'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill existing rows: use question id as its own group id when missing.
UPDATE `questions` SET `group_id` = `id` WHERE `group_id` IS NULL;
