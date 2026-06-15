import { readAppConfigText } from '@/lib/config.ts';
import { ProjectSettingsClient } from '@/components/ProjectSettingsClient.tsx';
import { AlertTriangle, BarChart3, Settings } from 'lucide-react';

type SearchParams = {
  setup?: string | string[];
};

function first(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SettingsPage({
  searchParams
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const config = readAppConfigText();
  const setupQuery = 'setup=missing_gitlab_project';
  const needsGitLabProject = first(params?.setup) === setupQuery.replace('setup=', '');

  return (
    <main className="app-shell">
      <header className="workspace-header settings-hero">
        <div className="brand">
          <span className="logo-mark">IF</span>
          <div>
            <p className="eyebrow">Project collection control</p>
            <h1>Settings</h1>
          </div>
          <span className="freshness">管理 GitLab 项目、token 与后台采集</span>
        </div>
        <nav className="nav">
          <a href="/">
            <BarChart3 size={16} strokeWidth={1.5} />
            Dashboard
          </a>
          <a href="/settings" className="active">
            <Settings size={16} strokeWidth={1.5} />
            Settings
          </a>
        </nav>
      </header>
      <div className="content">
        {needsGitLabProject && (
          <div className="setup-alert">
            <AlertTriangle size={18} strokeWidth={1.5} />
            <div>
              <strong>请先配置至少一个 GitLab 项目</strong>
              <span>Dashboard 以 GitLab Issue 为基础统计；保存项目 ID、路径和 token 后即可开始采集。</span>
            </div>
          </div>
        )}

        <ProjectSettingsClient />

        <section className="section">
          <div className="section-header">
            <div>
              <h2>配置快照</h2>
              <p>项目列表在后台数据库维护；这里展示 GitLab base URL 与采集默认配置。</p>
            </div>
          </div>
          <div className="settings-form">
            <textarea readOnly value={config || 'config/app.yml not found'} />
          </div>
        </section>
      </div>
    </main>
  );
}
