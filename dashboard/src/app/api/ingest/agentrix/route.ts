import { NextRequest, NextResponse } from 'next/server';
import { openDashboardDb } from '@/lib/db.ts';
import { ingestAgentrixBatch } from '@/lib/agentrix/ingest.ts';

function checkToken(request: NextRequest) {
  const configured = process.env.DASHBOARD_INGEST_TOKEN;
  if (!configured) {
    return true;
  }
  return request.headers.get('authorization') === `Bearer ${configured}`;
}

export async function POST(request: NextRequest) {
  if (!checkToken(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = await request.json();
  const db = openDashboardDb();
  try {
    const result = ingestAgentrixBatch(db, body);
    return NextResponse.json(result);
  } finally {
    db.close();
  }
}
