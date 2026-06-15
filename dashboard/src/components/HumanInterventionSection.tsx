import { formatNumber } from '@/lib/format.ts';
import type { getDashboardSummary } from '@/lib/queries.ts';

type Summary = ReturnType<typeof getDashboardSummary>;

export function HumanInterventionSection({ summary }: { summary: Summary }) {
  const rows = [
    ['流程 gate', 'Clarify / Approve 标签次数', summary.humanBreakdown.issueFlowGates, 'moss'],
    ['Agentrix 用户消息', '人工输入次数', summary.humanBreakdown.agentrixUserMessages, 'amber'],
    ['Agentrix 问题回答', '人工回复次数', summary.humanBreakdown.agentrixQuestionAnswers, 'coral']
  ] as const;
  const max = Math.max(1, ...rows.map(([, , value]) => value));

  return (
    <div className="panel">
      {rows.map(([label, copy, value, tone]) => (
        <div className="bar-row" key={label}>
          <span>
            {label}
            <em className="metric-row-copy">{copy}</em>
          </span>
          <div className="bar-track">
            <div className={`bar-fill ${tone === 'moss' ? '' : tone}`} style={{ width: `${Math.max(4, (value / max) * 100)}%` }} />
          </div>
          <strong>{formatNumber(value)}</strong>
        </div>
      ))}
    </div>
  );
}
