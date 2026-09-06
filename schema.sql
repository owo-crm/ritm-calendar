CREATE TABLE IF NOT EXISTS `ritm_calendars` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`state_json` text NOT NULL,
	`previous_state_json` text,
	`updated_at` text NOT NULL
);
