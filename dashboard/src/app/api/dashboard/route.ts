import { NextResponse } from 'next/server';
import { openDashboardDb } from '@/lib/db.ts';
import { getDashboardSummary, parseLocalDateRange, type WindowDays } from '@/lib/queries.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function parseWindow(value: string | null): WindowDays | 'all' {
  if (!value || value === 'all') return 'all';
  if (value === '7') return 7;
  if (value === '14') return 14;
  if (value === '30') return 30;
  return 'all';
}

export function GET(req: Request) {
  const url = new URL(req.url);
  const customRange = url.searchParams.get('window') === 'custom'
    ? parseLocalDateRange(url.searchParams.get('start'), url.searchParams.get('end'))
    : null;
  const db = openDashboardDb();
  try {
    return NextResponse.json(getDashboardSummary(db, {
      windowDays: parseWindow(url.searchParams.get('window')),
      windowStart: customRange?.since,
      windowEnd: customRange?.until,
      projectId: url.searchParams.get('project'),
      stageClosedOnly: url.searchParams.get('stage_closed_only') === '1'
    }));
  } finally {
    db.close();
  }
}
