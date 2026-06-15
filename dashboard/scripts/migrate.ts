import { openDashboardDb } from '../src/lib/db.ts';

const db = openDashboardDb();
db.close();
console.log('dashboard migration complete');
