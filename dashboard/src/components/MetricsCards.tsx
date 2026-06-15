import { formatDuration, formatNumber, formatPercent, formatTokenCount } from '@/lib/format.ts';
import type { getDashboardSummary } from '@/lib/queries.ts';
import { Bot, Bug, Cpu, GitPullRequest, MessageSquareText, RotateCcw, Timer, Workflow, type LucideIcon } from 'lucide-react';

type Summary = ReturnType<typeof getDashboardSummary>;

export function MetricsCards({ summary }: { summary: Summary }) {
  const tokenTotal = summary.totals.inputTokens + summary.totals.outputTokens;
  const metrics: Array<{ label: string; value: string; hint: string; Icon: LucideIcon }> = [
    { label: 'Issue 创建', value: formatNumber(summary.totals.createdCount), hint: '统计窗口内', Icon: GitPullRequest },
    { label: 'Issue 完成', value: formatNumber(summary.totals.completedCount), hint: '已关闭或有关闭事件', Icon: Workflow },
    { label: '平均完成', value: formatDuration(summary.totals.averageFirstCloseDurationSec), hint: '首次关闭耗时', Icon: Timer },
    { label: 'Human 介入', value: formatNumber(summary.totals.humanInterventionTotal), hint: 'gate + data.bin', Icon: MessageSquareText },
    { label: '自动化动作', value: formatNumber(summary.totals.automationActionCount), hint: 'plan / build', Icon: Bot },
    { label: 'Token 用量', value: formatTokenCount(tokenTotal), hint: 'tokens', Icon: Cpu },
    {
      label: 'Bug 占比',
      value: formatPercent(summary.totals.newBugLoadRate.rate),
      hint: `${formatNumber(summary.totals.newBugLoadRate.newBugs)} / ${formatNumber(summary.totals.newBugLoadRate.totalIssues)} issues`,
      Icon: Bug
    },
    {
      label: 'Reopen 率',
      value: formatPercent(summary.totals.reopenRate.rate),
      hint: `${formatNumber(summary.totals.reopenRate.numerator)} / ${formatNumber(summary.totals.reopenRate.denominator)} bugs`,
      Icon: RotateCcw
    }
  ];

  return (
    <div className="metric-grid">
      {metrics.map((metric) => (
        <div className="metric-card" key={metric.label}>
          <span className="metric-label">
            <metric.Icon size={16} strokeWidth={1.5} />
            {metric.label}
          </span>
          <strong>{metric.value}</strong>
          <span>{metric.hint}</span>
        </div>
      ))}
    </div>
  );
}
