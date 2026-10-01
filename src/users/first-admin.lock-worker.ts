// Runs in a real worker thread (node:worker_threads) so its `insertFirstAdmin` call is genuine OS-level concurrency
// against the main thread's raw SQLite connection — see the "serializes against a concurrent writer" test in
// first-admin.test.ts. A synchronous, single-threaded test cannot interleave two better-sqlite3 calls at all, so
// proving `{ behavior: 'immediate' }` (vs 'deferred') actually matters needs a second thread.
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../db/index.js';
import { insertFirstAdmin } from './first-admin.js';

const { file, busyTimeoutMs } = workerData as { file: string; busyTimeoutMs: number };
const db = openDb(file);
db.$client.pragma(`busy_timeout = ${busyTimeoutMs}`);
parentPort!.postMessage({ type: 'ready' });
try {
  const id = insertFirstAdmin(db, { email: 'b@example.com', name: 'B', passwordHash: 'h' });
  parentPort!.postMessage({ type: 'result', ok: true, id });
} catch (err) {
  parentPort!.postMessage({ type: 'result', ok: false, error: err instanceof Error ? err.message : String(err) });
}
