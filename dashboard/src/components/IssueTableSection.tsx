import { formatDate, formatDuration, formatNumber, formatTokenCount } from '@/lib/format.ts';
import type { IssueRow } from '@/lib/queries.ts';
import { STAGE_LABELS } from '@/lib/stages.ts';

const TYPE_OPTIONS = [
  ['feature', 'Feature'],
  ['bug', 'Bug'],
  ['debt', 'Debt'],
  ['ops', 'Ops'],
  ['design', 'Design'],
  ['spike', 'Spike'],
  ['group', 'Group']
] as const;

const ORDER_OPTIONS = [
  ['created_at', '创建时间'],
  ['first_closed_at', '首次关闭'],
  ['first_close_duration_sec', '完成时长'],
  ['reopen_count', 'Reopen 次数'],
  ['human_intervention_total', 'Human 介入'],
  ['token_total', 'Token 用量']
] as const;

function issueUrl(gitlabBaseUrl: string, row: IssueRow) {
  if (!row.projectPath) return null;
  return `${gitlabBaseUrl.replace(/\/+$/, '')}/${row.projectPath}/-/issues/${row.iid}`;
}

function stageLabel(stage: string | null) {
  return stage && stage in STAGE_LABELS ? STAGE_LABELS[stage as keyof typeof STAGE_LABELS] : (stage || 'Unknown');
}

export function IssueTableSection({
  gitlabBaseUrl,
  issues,
  page,
  pageSize,
  total,
  baseQuery,
  pageQuery,
  filters
}: {
  gitlabBaseUrl: string;
  issues: IssueRow[];
  page: number;
  pageSize: number;
  total: number;
  baseQuery: string;
  pageQuery: string;
  filters: {
    type: string;
    state: string;
    reopened: boolean;
    orderBy: string;
    order: 'asc' | 'desc';
  };
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hiddenParams = Array.from(new URLSearchParams(baseQuery).entries());
  const pageHref = (nextPage: number) => {
    const params = new URLSearchParams(pageQuery);
    params.set('t_page', String(nextPage));
    return `/?${params.toString()}`;
  };

  return (
    <>
      <form className="filter-bar" action="/" method="get">
        {hiddenParams.map(([key, value]) => (
          <input type="hidden" name={key} value={value} key={key} />
        ))}
        <label>
          类型
          <select name="t_type" defaultValue={filters.type}>
            <option value="">全部</option>
            {TYPE_OPTIONS.map(([value, label]) => (
              <option value={value} key={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select name="t_state" defaultValue={filters.state}>
            <option value="">全部</option>
            <option value="opened">Opened</option>
            <option value="closed">Closed</option>
          </select>
        </label>
        <label className="check-label">
          <input className="custom-check" type="checkbox" name="t_reopened" value="1" defaultChecked={filters.reopened} />
          只看被 reopen 过的
        </label>
        <label className="push-right">
          排序
          <select name="t_order_by" defaultValue={filters.orderBy}>
            {ORDER_OPTIONS.map(([value, label]) => (
              <option value={value} key={value}>{label}</option>
            ))}
          </select>
        </label>
        <select name="t_order" defaultValue={filters.order} aria-label="排序方向">
          <option value="desc">倒序</option>
          <option value="asc">升序</option>
        </select>
        <button type="submit">筛选</button>
      </form>

      <div className="table-wrap">
        <table className="data-table issue-data-table">
          <thead>
            <tr>
              <th>项目</th>
              <th>#</th>
              <th>标题</th>
              <th>Type</th>
              <th>状态</th>
              <th>当前阶段</th>
              <th>创建时间</th>
              <th>首次关闭</th>
              <th>Tasks</th>
              <th>Human</th>
              <th>Token 用量</th>
              <th>完成时长</th>
            </tr>
          </thead>
          <tbody>
            {issues.length === 0 && (
              <tr>
                <td colSpan={12} className="empty-cell">暂无 Issue 数据。</td>
              </tr>
            )}
            {issues.map((row) => {
              const url = issueUrl(gitlabBaseUrl, row);
              const tokenTotal = row.input_tokens + row.output_tokens;
              return (
                <tr key={`${row.project_id}:${row.iid}`}>
                  <td>{row.projectName ?? row.project_id}</td>
                  <td>{url ? <a href={url} target="_blank" rel="noreferrer">#{row.iid}</a> : `#${row.iid}`}</td>
                  <td className="title-cell">{url ? <a href={url} target="_blank" rel="noreferrer">{row.title ?? 'Untitled issue'}</a> : (row.title ?? 'Untitled issue')}</td>
                  <td><span className={`badge type-${row.issue_type ?? 'unknown'}`}>{row.issue_type ?? '-'}</span></td>
                  <td><span className={`badge state-${row.state ?? 'unknown'}`}>{row.state ?? '-'}</span></td>
                  <td><span className={`badge stage-${row.current_flow_stage ?? 'unknown'}`}>{stageLabel(row.current_flow_stage)}</span></td>
                  <td>{formatDate(row.created_at)}</td>
                  <td>{formatDate(row.first_closed_at)}</td>
                  <td>{formatNumber(row.agentrixTaskCount)}</td>
                  <td>{formatNumber(row.human_intervention_total)}</td>
                  <td>{formatTokenCount(tokenTotal)}</td>
                  <td>{formatDuration(row.first_close_duration_sec)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <span>共 {formatNumber(total)} 条 · 第 {page} / {totalPages} 页</span>
        {page > 1 && <a href={pageHref(page - 1)}>上一页</a>}
        {page < totalPages && <a href={pageHref(page + 1)}>下一页</a>}
      </div>
    </>
  );
}
