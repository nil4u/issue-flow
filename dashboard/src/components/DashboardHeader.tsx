import { formatDateTime, formatRelativeTime } from '@/lib/format.ts';
import type { getDashboardSummary } from '@/lib/queries.ts';
import { BarChart3, CalendarDays, CheckCircle2, Filter, Settings } from 'lucide-react';

type Summary = ReturnType<typeof getDashboardSummary>;

function windowHref(window: string, projectId?: string | null) {
  const params = new URLSearchParams();
  if (window !== 'all') params.set('window', window);
  if (projectId) params.set('project', projectId);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

export function DashboardHeader({ summary, projectId }: { summary: Summary; projectId?: string | null }) {
  const freshness = summary.freshness.lastSuccessAt;
  const activeWindow = summary.window.mode === 'all' ? 'all' : String(summary.window.days ?? 'custom');

  return (
    <header className="workspace-header dashboard-header">
      <div className="header-main">
        <div className="brand">
          <span className="logo-mark">IF</span>
          <div>
            <p className="eyebrow">Agentic delivery observability</p>
            <h1>Issue Flow Dashboard</h1>
          </div>
          <span className="freshness">
            <CheckCircle2 size={15} strokeWidth={1.5} />
            数据更新于 <b>{formatRelativeTime(freshness)}</b>
            {freshness ? ` (${formatDateTime(freshness)})` : ''}
          </span>
        </div>
        <nav className="nav">
          <a href="/" className="active">
            <BarChart3 size={16} strokeWidth={1.5} />
            Dashboard
          </a>
          <a href="/settings">
            <Settings size={16} strokeWidth={1.5} />
            Settings
          </a>
        </nav>
      </div>

      <div className="toolbar">
        <form className="project-filter" action="/" method="get">
          {activeWindow !== 'all' && <input type="hidden" name="window" value={activeWindow} />}
          <label>
            <Filter size={15} strokeWidth={1.5} />
            项目
            <select name="project" defaultValue={projectId ?? ''}>
              <option value="">全部项目</option>
              {summary.projects.map((project) => (
                <option value={project.id} key={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">应用</button>
        </form>

        <div className="window-tabs" role="group" aria-label="统计窗口">
          {[
            ['all', '全量累计'],
            ['7', '最近 7 天'],
            ['14', '最近 14 天'],
            ['30', '最近 30 天']
          ].map(([key, label]) => (
            <a className={activeWindow === key ? 'active' : ''} href={windowHref(key, projectId)} key={key}>
              {label}
            </a>
          ))}
        </div>

        <form className="custom-window" action="/" method="get">
          <input type="hidden" name="window" value="custom" />
          {projectId && <input type="hidden" name="project" value={projectId} />}
          <CalendarDays size={15} strokeWidth={1.5} />
          <input type="date" name="start" aria-label="开始日期" />
          <span>至</span>
          <input type="date" name="end" aria-label="结束日期" />
          <button type="submit">自定义</button>
        </form>
      </div>
    </header>
  );
}
