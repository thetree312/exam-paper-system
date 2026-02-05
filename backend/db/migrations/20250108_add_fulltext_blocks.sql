CREATE TABLE IF NOT EXISTS fulltext_blocks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  file_id BIGINT UNSIGNED NOT NULL,
  page_num INT NOT NULL DEFAULT 1,
  block_index INT NOT NULL DEFAULT 0,
  content LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_fulltext_blocks_file
    FOREIGN KEY (file_id) REFERENCES files(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_fulltext_blocks_file_page
  ON fulltext_blocks (file_id, page_num, block_index);
