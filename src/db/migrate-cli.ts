import { closeDb, openDb } from './index.js';
const db = openDb(process.env.DATABASE_PATH ?? 'data/ica-hub.db');
console.log('migrations applied');
closeDb(db);
