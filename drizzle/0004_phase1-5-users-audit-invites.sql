CREATE TABLE `audit_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`ip` text,
	`user_agent` text,
	`outcome` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_event_at_idx` ON `audit_event` (`at`);--> statement-breakpoint
CREATE INDEX `audit_event_actor_at_idx` ON `audit_event` (`actor_user_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_event_action_at_idx` ON `audit_event` (`action`,`at`);--> statement-breakpoint
CREATE TABLE `invite` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`accepted_user_id` text,
	`revoked_at` text,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`accepted_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_token_hash_unique` ON `invite` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invite_email_idx` ON `invite` (`email`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_profile` (
	`user_id` text PRIMARY KEY NOT NULL,
	`ica_account_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ica_account_id`) REFERENCES `ica_account`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_user_profile`("user_id", "ica_account_id", "created_at") SELECT "user_id", "ica_account_id", "created_at" FROM `user_profile`;--> statement-breakpoint
DROP TABLE `user_profile`;--> statement-breakpoint
ALTER TABLE `__new_user_profile` RENAME TO `user_profile`;--> statement-breakpoint
PRAGMA foreign_keys=ON;