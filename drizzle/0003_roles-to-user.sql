-- Better Auth's user.role becomes the only role source (Phase 1.5). Profile admins win; everything else is 'member'.
UPDATE `user` SET `role` = 'admin' WHERE `id` IN (SELECT `user_id` FROM `user_profile` WHERE `role` = 'admin');
--> statement-breakpoint
UPDATE `user` SET `role` = 'member' WHERE `role` IS NULL OR `role` NOT IN ('admin', 'member');
--> statement-breakpoint
-- Profiles of users that no longer exist would violate the new foreign key in 0004.
DELETE FROM `user_profile` WHERE `user_id` NOT IN (SELECT `id` FROM `user`);
