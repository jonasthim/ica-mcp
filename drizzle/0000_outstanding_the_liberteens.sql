CREATE TABLE `api_token` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_token_token_hash_unique` ON `api_token` (`token_hash`);--> statement-breakpoint
CREATE TABLE `household` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text DEFAULT 'Household' NOT NULL,
	`designated_handla_account_id` text,
	`default_store_id` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ica_account` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`personnummer_enc` text NOT NULL,
	`password_enc` text NOT NULL,
	`handla_store_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ica_session` (
	`id` text PRIMARY KEY NOT NULL,
	`ica_account_id` text NOT NULL,
	`kind` text NOT NULL,
	`state_enc` text NOT NULL,
	`expires_at` text,
	`last_ok_at` text,
	`last_error` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`ica_account_id`) REFERENCES `ica_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_profile` (
	`user_id` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`ica_account_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ica_account_id`) REFERENCES `ica_account`(`id`) ON UPDATE no action ON DELETE set null
);
