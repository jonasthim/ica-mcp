import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth-schema.js';
export * from './auth-schema.js';

export const household = sqliteTable('household', {
  id: integer('id').primaryKey(), // always 1
  name: text('name').notNull().default('Household'),
  designatedHandlaAccountId: text('designated_handla_account_id'),
  defaultStoreId: integer('default_store_id'),
  updatedAt: text('updated_at').notNull(),
});

export const icaAccount = sqliteTable('ica_account', {
  id: text('id').primaryKey(), // uuid
  displayName: text('display_name').notNull(), // BankID-only: no personnummer or password is ever stored
  handlaStoreId: text('handla_store_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  /**
   * HMAC (Cipher.mac) of the ICA person's stable id from the web login / app token, never the id itself; null when
   * ICA gave none. Used to refuse a BankID login of another person (src/sessions/identity.ts).
   */
  webSubjectHash: text('web_subject_hash'),
  appSubjectHash: text('app_subject_hash'),
});

export const userProfile = sqliteTable('user_profile', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }), // = Better Auth user.id; role lives on user.role
  icaAccountId: text('ica_account_id').references(() => icaAccount.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  emailSelfChangedAt: text('email_self_changed_at'), // set when a member changed their own email; an admin's save clears it
});

export const icaSession = sqliteTable('ica_session', {
  id: text('id').primaryKey(),
  icaAccountId: text('ica_account_id').notNull().references(() => icaAccount.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['app', 'web', 'handla'] }).notNull(),
  stateEnc: text('state_enc').notNull(), // encrypted JSON: tokens / cookies / csrf
  expiresAt: text('expires_at'),
  lastOkAt: text('last_ok_at'),
  lastError: text('last_error'),
  /** When BankID connected this session (web: the web login; app: the app login). ICA's 4-hour app window starts here. */
  connectedAt: text('connected_at'),
  /** App sessions: when the tokens were last issued (connect or refresh). */
  refreshedAt: text('refreshed_at'),
  /** Web sessions: the loginState ICA last reported (2 = purchase history available) and when it was checked. */
  loginState: integer('login_state'),
  loginStateAt: text('login_state_at'),
  updatedAt: text('updated_at').notNull(),
});

export const apiToken = sqliteTable('api_token', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(), // sha256 of the bearer
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
});

/** Security-relevant actions (spec "Audit"). No FK on actor: the trail must outlive a removed user. */
export const auditEvent = sqliteTable('audit_event', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: text('at').notNull(), // ISO-8601 UTC
  actorUserId: text('actor_user_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  outcome: text('outcome', { enum: ['success', 'failure'] }).notNull(),
  detailsJson: text('details_json').notNull().default('{}'),
}, (t) => [index('audit_event_at_idx').on(t.at), index('audit_event_actor_at_idx').on(t.actorUserId, t.at), index('audit_event_action_at_idx').on(t.action, t.at)]);

/** Single-use household invites (spec "Invites"). Only the SHA-256 of the token is stored. */
export const invite = sqliteTable('invite', {
  id: text('id').primaryKey(),
  email: text('email').notNull(), // lowercased
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  acceptedAt: text('accepted_at'),
  acceptedUserId: text('accepted_user_id').references(() => user.id, { onDelete: 'set null' }),
  revokedAt: text('revoked_at'),
}, (t) => [index('invite_email_idx').on(t.email)]);

/** Instance settings edited in the admin UI (spec 1.6 "Instance settings storage"). Secrets inside value_json are encrypted. */
export const appSetting = sqliteTable('app_setting', {
  key: text('key').primaryKey(), // 'oidc' | 'sign_in_methods'
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
});
