import { eq } from 'drizzle-orm';
import * as z from 'zod/v4';
import { schema, type Db } from '../db/index.js';

/** A Drizzle transaction on {@link Db}: the writers accept one, so a settings row commits together with other changes. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type SettingKey = 'oidc' | 'sign_in_methods';

/** The OIDC row. `clientSecretEnc` is a `v1.` envelope from createCipher(masterKey); the plaintext is never stored. */
export const StoredOidcSchema = z.object({
  issuerUrl: z.url(), clientId: z.string().min(1).max(200), clientSecretEnc: z.string().startsWith('v1.'),
  label: z.string().min(1).max(40), linkByEmail: z.boolean(), adminGroup: z.string().min(1).max(100).optional(),
  // Optional, so rows stored before the member group existed stay valid (no migration).
  memberGroup: z.string().min(1).max(100).optional(),
});
export type StoredOidc = z.infer<typeof StoredOidcSchema>;
export const StoredSignInSchema = z.object({ localLogin: z.boolean() });
export type StoredSignIn = z.infer<typeof StoredSignInSchema>;

export type ReadResult<T> = { state: 'absent' } | { state: 'ok'; value: T } | { state: 'invalid' };

/** One settings row, parsed. A row that is not JSON or not the expected shape is `invalid`, never an exception. */
export function readSetting<T>(db: Db, key: SettingKey, s: z.ZodType<T>): ReadResult<T> {
  const row = db.select({ v: schema.appSetting.valueJson }).from(schema.appSetting).where(eq(schema.appSetting.key, key)).get();
  if (!row) return { state: 'absent' };
  let raw: unknown;
  try { raw = JSON.parse(row.v); } catch { return { state: 'invalid' }; }
  const parsed = s.safeParse(raw);
  return parsed.success ? { state: 'ok', value: parsed.data } : { state: 'invalid' };
}

/** Upserts one settings row. The caller encrypts secrets first (StoredOidc carries only the envelope). */
export function writeSetting(db: Db | Tx, key: SettingKey, value: StoredOidc | StoredSignIn, updatedBy: string | null, now: Date = new Date()): void {
  const row = { key, valueJson: JSON.stringify(value), updatedAt: now.toISOString(), updatedBy };
  db.insert(schema.appSetting).values(row).onConflictDoUpdate({ target: schema.appSetting.key, set: { valueJson: row.valueJson, updatedAt: row.updatedAt, updatedBy } }).run();
}

/** Removes one settings row; true when a row existed. */
export function deleteSetting(db: Db | Tx, key: SettingKey): boolean {
  return db.delete(schema.appSetting).where(eq(schema.appSetting.key, key)).run().changes > 0;
}
