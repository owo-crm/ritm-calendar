CREATE TABLE IF NOT EXISTS `ritm_calendars` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`state_json` text NOT NULL,
	`previous_state_json` text,
	`updated_at` text NOT NULL
);
CREATE TABLE IF NOT EXISTS ritm_files (
  id TEXT PRIMARY KEY NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ritm_file_chunks (
  file_id TEXT NOT NULL REFERENCES ritm_files(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, position)
);
CREATE TRIGGER IF NOT EXISTS ritm_file_quota BEFORE INSERT ON ritm_files
WHEN NOT EXISTS (SELECT 1 FROM ritm_files WHERE id = NEW.id)
AND (SELECT COALESCE(SUM(size), 0) FROM ritm_files) + NEW.size > 104857600
BEGIN SELECT RAISE(ABORT, 'RITM_FILE_QUOTA'); END;
