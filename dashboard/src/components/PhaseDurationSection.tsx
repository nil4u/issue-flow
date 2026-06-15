import { formatDuration } from '@/lib/format.ts';
import type { getDashboardSummary } from '@/lib/queries.ts';

type Summary = ReturnType<typeof getDashboardSummary>;

export function PhaseDurationSection({ summary }: { summary: Summary }) {
  const rows = [
    ['Intake', 'Triage + Clarify', summary.stageTotals.intakeDurationSec, 'moss'],
    ['Plan', 'Plan + Approve', summary.stageTotals.planDurationSec, 'cyan'],
    ['Delivery', 'Build 阶段', summary.stageTotals.deliveryDurationSec, 'amber']
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
          <strong>{formatDuration(value)}</strong>
        </div>
      ))}
    </div>
  );
}
