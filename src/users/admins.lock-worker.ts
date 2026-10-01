// Runs in a real worker thread so its `syncGroupRole` call is genuine concurrency against the main thread's own
// SQLite connection — see the "last two admins" test in admins.test.ts (the same pattern as first-admin.lock-worker.ts).
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../db/index.js';
import { syncGroupRole } from './admins.js';

const { file, busyTimeoutMs, userId } = workerData as { file: string; busyTimeoutMs: number; userId: string };
const db = openDb(file);
db.$client.pragma(`busy_timeout = ${busyTimeoutMs}`);
parentPort!.postMessage({ type: 'ready' });
try {
  parentPort!.postMessage({ type: 'result', ok: true, outcome: syncGroupRole(db, userId, 'member') });
} catch (err) {
  parentPort!.postMessage({ type: 'result', ok: false, error: err instanceof Error ? err.message : String(err) });
}
