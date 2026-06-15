import { NextResponse } from 'next/server';
import { openDashboardDb } from '@/lib/db.ts';

export function GET() {
  const db = openDashboardDb();
  try {
    const lastRun = db.prepare('select * from collection_runs order by id desc limit 1').get() ?? null;
    const syncRows = db.prepare('select * from agentrix_sync_state order by last_synced_at desc limit 20').all();
    return NextResponse.json({ lastRun, syncRows });
  } finally {
    db.close();
  }
}
