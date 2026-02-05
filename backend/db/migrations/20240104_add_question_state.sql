-- Adds student answer + grading status fields required by the agent workflow.
-- Run this once against the same database configured in backend/.env (default: exam_paper).

USE `exam_paper`;

SET @table_schema := DATABASE();

-- student_answer
SET @missing_student_answer :=
  (SELECT COUNT(*) = 0
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @table_schema
      AND TABLE_NAME = 'questions'
      AND COLUMN_NAME = 'student_answer');
SET @sql := IF(
  @missing_student_answer,
  'ALTER TABLE `questions` ADD COLUMN `student_answer` MEDIUMTEXT NULL AFTER `legend_images`',
  'SELECT "student_answer already exists"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- grading_judgement
SET @missing_grading_judgement :=
  (SELECT COUNT(*) = 0
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @table_schema
      AND TABLE_NAME = 'questions'
      AND COLUMN_NAME = 'grading_judgement');
SET @sql := IF(
  @missing_grading_judgement,
  'ALTER TABLE `questions` ADD COLUMN `grading_judgement` VARCHAR(32) NULL AFTER `student_answer`',
  'SELECT "grading_judgement already exists"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- grading_predicted_answer
SET @missing_grading_predicted :=
  (SELECT COUNT(*) = 0
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @table_schema
      AND TABLE_NAME = 'questions'
      AND COLUMN_NAME = 'grading_predicted_answer');
SET @sql := IF(
  @missing_grading_predicted,
  'ALTER TABLE `questions` ADD COLUMN `grading_predicted_answer` MEDIUMTEXT NULL AFTER `grading_judgement`',
  'SELECT "grading_predicted_answer already exists"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- grading_reasoning
SET @missing_grading_reasoning :=
  (SELECT COUNT(*) = 0
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @table_schema
      AND TABLE_NAME = 'questions'
      AND COLUMN_NAME = 'grading_reasoning');
SET @sql := IF(
  @missing_grading_reasoning,
  'ALTER TABLE `questions` ADD COLUMN `grading_reasoning` MEDIUMTEXT NULL AFTER `grading_predicted_answer`',
  'SELECT "grading_reasoning already exists"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- grading_confidence
SET @missing_grading_confidence :=
  (SELECT COUNT(*) = 0
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @table_schema
      AND TABLE_NAME = 'questions'
      AND COLUMN_NAME = 'grading_confidence');
SET @sql := IF(
  @missing_grading_confidence,
  'ALTER TABLE `questions` ADD COLUMN `grading_confidence` DOUBLE NULL AFTER `grading_reasoning`',
  'SELECT "grading_confidence already exists"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
