-- 在你明确选择的独立数据库中执行；不创建或修改任何业务库及全局配置。
CREATE TABLE IF NOT EXISTS flowboard_rooms (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  title VARCHAR(40) NOT NULL,
  management_hash BINARY(32) NOT NULL,
  y_state MEDIUMBLOB NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
