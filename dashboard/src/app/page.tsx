import { openDashboardDb } from '@/lib/db.ts';
import { loadAppConfig } from '@/lib/config.ts';
import { readConfiguredProjects } from '@/lib/projects.ts';
import { getDashboardSummary, parseLocalDateRange, queryIssueList, type IssueListFilter, type WindowDays } from '@/lib/queries.ts';
import { MetricsCards } from '@/components/MetricsCards.tsx';
import { HumanInterventionSection } from '@/components/HumanInterventionSection.tsx';
import { PhaseDurationSection } from '@/components/PhaseDurationSection.tsx';
import { IssueTableSection } from '@/components/IssueTableSection.tsx';
import { DashboardHeader } from '@/components/DashboardHeader.tsx';
import { OpenIssuesSection } from '@/components/OpenIssuesSection.tsx';
import { StageMetricsSection } from '@/components/StageMetricsSection.tsx';
import { TrendSection } from '@/components/TrendSection.tsx';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

type SearchParams = {
  window?: string | string[];
  start?: string | string[];
  end?: string | string[];
  project?: string | string[];
  stage_closed_only?: string | string[];
  t_type?: string | string[];
  t_state?: string | string[];
  t_reopened?: string | string[];
  t_order_by?: string | string[];
  t_order?: string | string[];
  t_page?: string | string[];
};

function first(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function parseWindow(value?: string | string[]): WindowDays | 'all' {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === '7') return 7;
  if (raw === '14') return 14;
  if (raw === '30') return 30;
  return 'all';
}

function parseOrderBy(value?: string): IssueListFilter['orderBy'] {
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

export default async function DashboardPage({
  searchParams
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const rawWindow = first(params?.window);
  const customRange = rawWindow === 'custom'
    ? parseLocalDateRange(first(params?.start), first(params?.end))
    : null;
  const projectId = first(params?.project) || null;
  const stageClosedOnly = first(params?.stage_closed_only) === '1';
  const db = openDashboardDb();
  if (readConfiguredProjects(db).length === 0) {
    db.close();
    redirect('/settings?setup=missing_gitlab_project');
  }
  const summary = getDashboardSummary(db, {
    windowDays: parseWindow(params?.window),
    windowStart: customRange?.since,
    windowEnd: customRange?.until,
    projectId,
    stageClosedOnly
  });
  const issueList = queryIssueList(db, {
    projectId,
    type: first(params?.t_type) || null,
    state: first(params?.t_state) === 'opened' || first(params?.t_state) === 'closed'
      ? (first(params?.t_state) as 'opened' | 'closed')
      : null,
    onlyReopened: first(params?.t_reopened) === '1',
    page: Math.max(1, Number(first(params?.t_page) ?? '1') || 1),
    pageSize: 50,
    orderBy: parseOrderBy(first(params?.t_order_by)),
    order: first(params?.t_order) === 'asc' ? 'asc' : 'desc'
  });
  const gitlabBaseUrl = loadAppConfig().gitlab.baseUrl;
  db.close();
  const baseParams = new URLSearchParams();
  if (rawWindow && rawWindow !== 'all') baseParams.set('window', rawWindow);
  if (first(params?.start)) baseParams.set('start', first(params?.start)!);
  if (first(params?.end)) baseParams.set('end', first(params?.end)!);
  if (projectId) baseParams.set('project', projectId);
  if (stageClosedOnly) baseParams.set('stage_closed_only', '1');
  const tableParams = new URLSearchParams(baseParams);
  if (first(params?.t_type)) tableParams.set('t_type', first(params?.t_type)!);
  if (first(params?.t_state)) tableParams.set('t_state', first(params?.t_state)!);
  if (first(params?.t_reopened)) tableParams.set('t_reopened', first(params?.t_reopened)!);
  if (first(params?.t_order_by)) tableParams.set('t_order_by', first(params?.t_order_by)!);
  if (first(params?.t_order)) tableParams.set('t_order', first(params?.t_order)!);
  const stageToggleParams = new URLSearchParams(baseParams);
  if (stageClosedOnly) stageToggleParams.delete('stage_closed_only');
  else stageToggleParams.set('stage_closed_only', '1');
  const stageToggleHref = stageToggleParams.toString() ? `/?${stageToggleParams.toString()}` : '/';

  return (
    <main className="app-shell">
      <DashboardHeader summary={summary} projectId={projectId} />

      <div className="content">
        <section className="section">
          <div className="section-header">
            <div>
              <h2>主指标</h2>
              <p>{summary.window.label} · 按 Issue 创建时间归属统计，面向全自动 issue-flow 的效率、人类介入与 token 用量。</p>
            </div>
          </div>
          <MetricsCards summary={summary} />
        </section>

        <section className="section">
          <div className="section-header">
            <div>
              <h2>Human 介入与阶段耗时</h2>
              <p>Human 介入次数 = 流程层 gate + Agentrix data.bin 用户消息 + 问题回答。</p>
            </div>
          </div>
          <div className="split">
            <HumanInterventionSection summary={summary} />
            <PhaseDurationSection summary={summary} />
          </div>
        </section>

        <StageMetricsSection summary={summary} stageClosedOnly={stageClosedOnly} toggleHref={stageToggleHref} />

        <TrendSection points={summary.trend} />

        <OpenIssuesSection summary={summary.openIssueSummary} />

        <section className="section">
          <div className="section-header">
            <div>
              <h2>Issue 明细</h2>
              <p>
                按最近更新时间展示，`flow::review` 已从统计口径中忽略。
                {summary.dataQuality.unlinkedAgentrixTaskCount > 0
                  ? ` 另有 ${summary.dataQuality.unlinkedAgentrixTaskCount} 个 Agentrix task 未关联 Issue，仅作为数据质量提示。`
                  : ' Agentrix task 已归入 Issue 指标。'}
              </p>
            </div>
          </div>
          <IssueTableSection
            gitlabBaseUrl={gitlabBaseUrl}
            issues={issueList.rows}
            page={issueList.page}
            pageSize={issueList.pageSize}
            total={issueList.total}
            baseQuery={baseParams.toString()}
            pageQuery={tableParams.toString()}
            filters={{
              type: first(params?.t_type) || '',
              state: first(params?.t_state) || '',
              reopened: first(params?.t_reopened) === '1',
              orderBy: first(params?.t_order_by) || 'created_at',
              order: first(params?.t_order) === 'asc' ? 'asc' : 'desc'
            }}
          />
        </section>
      </div>
    </main>
  );
}
