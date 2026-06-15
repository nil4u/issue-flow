import { NextResponse } from 'next/server';
import { openDashboardDb } from '@/lib/db.ts';
import { queryIssueList, type IssueListFilter } from '@/lib/queries.ts';
import { loadAppConfig } from '@/lib/config.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function parseOrderBy(value: string | null): IssueListFilter['orderBy'] {
  if (
    value === 'first_closed_at' ||
    value === 'first_close_duration_sec' ||
    value === 'reopen_count' ||
    value === 'token_total' ||
    value === 'human_intervention_total'
  ) {
    return value;
  }
  if (value === 'token_cost_usd') return 'token_total';
  return 'created_at';
}

export function GET(req: Request) {
  const url = new URL(req.url);
  const db = openDashboardDb();
  try {
    const result = queryIssueList(db, {
      projectId: url.searchParams.get('project'),
      type: url.searchParams.get('type'),
      state: url.searchParams.get('state') === 'opened' || url.searchParams.get('state') === 'closed'
        ? (url.searchParams.get('state') as 'opened' | 'closed')
        : null,
      onlyReopened: url.searchParams.get('only_reopened') === '1',
      page: Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1),
      pageSize: Math.min(200, Math.max(1, Number(url.searchParams.get('page_size') ?? '50') || 50)),
      orderBy: parseOrderBy(url.searchParams.get('order_by')),
      order: url.searchParams.get('order') === 'asc' ? 'asc' : 'desc'
    });
    return NextResponse.json({
      ...result,
      page_size: result.pageSize,
      gitlab_base_url: loadAppConfig().gitlab.baseUrl
    });
  } finally {
    db.close();
  }
}
