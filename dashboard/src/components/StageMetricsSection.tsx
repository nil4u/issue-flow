import { formatDuration, formatPercent } from '@/lib/format.ts';
import type { getDashboardSummary } from '@/lib/queries.ts';
import { FLOW_STAGES, STAGE_COLORS, STAGE_DESCRIPTIONS, STAGE_LABELS } from '@/lib/stages.ts';

type Summary = ReturnType<typeof getDashboardSummary>;

export function StageMetricsSection({
  summary,
  stageClosedOnly,
  toggleHref
}: {
  summary: Summary;
  stageClosedOnly: boolean;
  toggleHref: string;
}) {
  const share = summary.stageShare.total;
  const gradient = FLOW_STAGES.map((stage) => {
    const start = FLOW_STAGES
      .slice(0, FLOW_STAGES.indexOf(stage))
      .reduce((sum, key) => sum + (share.stages[key].share ?? 0), 0);
    const end = start + (share.stages[stage].share ?? 0);
    return `${STAGE_COLORS[stage]} ${start * 100}% ${end * 100}%`;
  }).join(', ');

  return (
    <section className="section">
      <div className="section-header">
        <div>
          <h2>阶段耗时占比</h2>
          <p>总耗时分布 · 平均每 Issue 耗时 · 阶段分位数按当前窗口创建 Issue 计算。</p>
        </div>
        <a className="button-link" href={toggleHref}>{stageClosedOnly ? '统计全部 Issue' : '仅统计已关闭 Issue'}</a>
      </div>

      <div className="stage-grid">
        <div className="stage-donut-card">
          <div
            className="stage-donut"
            style={{ background: share.totalSeconds > 0 ? `conic-gradient(${gradient})` : '#eef2e8' }}
          >
            <div>
              <strong>总 {formatDuration(share.totalSeconds)}</strong>
              <span>均 {formatDuration(share.averageSeconds)} / Issue</span>
            </div>
          </div>
        </div>
        <div className="stage-legend">
          {FLOW_STAGES.map((stage) => {
            const item = share.stages[stage];
            return (
              <div className={stage === 'unknown' ? 'stage-legend-row muted-row' : 'stage-legend-row'} key={stage}>
                <span>
                  <i style={{ background: STAGE_COLORS[stage] }} />
                  {STAGE_LABELS[stage]}
                </span>
                <b style={{ color: STAGE_COLORS[stage] }}>{formatPercent(item.share)}</b>
                <span>总耗时 {formatDuration(item.seconds)}</span>
                <span>平均 {formatDuration(item.averageSeconds)}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>阶段</th>
              <th>P50</th>
              <th>P75</th>
              <th>P90</th>
              <th>Issue 数</th>
            </tr>
          </thead>
          <tbody>
            {FLOW_STAGES.map((stage) => {
              const q = summary.stageDurations[stage];
              return (
                <tr key={stage}>
                  <td>
                    <strong>{STAGE_LABELS[stage]}</strong>
                    <span className="cell-sub">{STAGE_DESCRIPTIONS[stage]}</span>
                  </td>
                  <td>{formatDuration(q.p50)}</td>
                  <td>{formatDuration(q.p75)}</td>
                  <td>{formatDuration(q.p90)}</td>
                  <td>{q.n}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
