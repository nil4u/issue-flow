import { FLOW_STAGES, STAGE_LABELS } from '@/lib/stages.ts';

const ISSUE_TYPES = [
  ['feature', 'Feature'],
  ['bug', 'Bug'],
  ['debt', 'Debt'],
  ['ops', 'Ops'],
  ['design', 'Design'],
  ['spike', 'Spike'],
  ['group', 'Group'],
  ['unknown', 'Unknown']
] as const;

export function OpenIssuesSection({
  summary
}: {
  summary: {
    total: number;
    byStage: Record<string, number>;
    byType: Record<string, number>;
  };
}) {
  return (
    <section className="section">
      <div className="section-header">
        <div>
          <h2>当前 Open Issues</h2>
          <p>采集时刻瞬时快照 · 与窗口无关 · 总计 {summary.total} 个</p>
        </div>
      </div>
      <div className="open-grid">
        <div className="panel">
          <h3>按阶段</h3>
          <div className="badge-line">
            {FLOW_STAGES.map((stage) => (
              <span className={`badge stage-${stage}`} key={stage}>
                {STAGE_LABELS[stage]} <b>{summary.byStage[stage] ?? 0}</b>
              </span>
            ))}
          </div>
        </div>
        <div className="panel">
          <h3>按类型</h3>
          <div className="badge-line">
            {ISSUE_TYPES.map(([type, label]) => (
              <span className={`badge type-${type}`} key={type}>
                {label} <b>{summary.byType[type] ?? 0}</b>
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
