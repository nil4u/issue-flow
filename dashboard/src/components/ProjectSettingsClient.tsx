'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Database, KeyRound, Plus, Power, RefreshCw, Save, Trash2 } from 'lucide-react';

type Project = {
  id: string;
  name: string | null;
  path_with_namespace: string | null;
  provider: string | null;
  active: number;
  token_mask: string;
  last_success_at: number | null;
  last_error: string | null;
};

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

async function readJson(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json;
}

export function ProjectSettingsClient() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [pathWithNamespace, setPathWithNamespace] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [tokenDrafts, setTokenDrafts] = useState<Record<string, string>>({});

  const reload = async () => {
    const json = await readJson('/api/projects');
    setProjects(json.projects ?? []);
  };

  useEffect(() => {
    reload().catch((err) => setError(errorMessage(err)));
  }, []);

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      await action();
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      await readJson('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ id, name, pathWithNamespace, token })
      });
      setId('');
      setName('');
      setPathWithNamespace('');
      setToken('');
      setMessage('项目已保存');
    });
  };

  const updateToken = async (project: Project) => {
    const draft = tokenDrafts[project.id]?.trim();
    if (!draft) return;
    await run(async () => {
      await readJson(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: project.name,
          pathWithNamespace: project.path_with_namespace,
          active: project.active === 1,
          token: draft
        })
      });
      setTokenDrafts((prev) => ({ ...prev, [project.id]: '' }));
      setMessage('token 已更新');
    });
  };

  const collect = async () => {
    await run(async () => {
      const json = await readJson('/api/admin/collect', { method: 'POST' });
      setMessage(`采集完成：${json.status}`);
    });
  };

  return (
    <div className="settings-grid">
      <section className="panel settings-panel">
        <div className="panel-title">
          <span className="icon-frame"><Database size={17} strokeWidth={1.5} /></span>
          <div>
            <h2>项目配置</h2>
            <p>后台维护要采集的 GitLab 项目。</p>
          </div>
        </div>
        <form className="project-form" onSubmit={submit}>
          <label>
            GitLab 项目 ID
            <input value={id} onChange={(e) => setId(e.currentTarget.value)} placeholder="43371" required />
          </label>
          <label>
            项目路径
            <input
              value={pathWithNamespace}
              onChange={(e) => setPathWithNamespace(e.currentTarget.value)}
              placeholder="huilian/wandou-kanban"
              required
            />
          </label>
          <label>
            项目名称
            <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="wandou-kanban" />
          </label>
          <label>
            GitLab token
            <input
              value={token}
              onChange={(e) => setToken(e.currentTarget.value)}
              placeholder="glpat-..."
              type="password"
              required
            />
          </label>
          <button type="submit" disabled={pending}>
            <Save size={16} strokeWidth={1.5} />
            保存项目
          </button>
        </form>
        {message && <p className="success-text">{message}</p>}
        {error && <p className="error-text">{error}</p>}
      </section>

      <section className="panel settings-panel">
        <div className="section-header tight">
          <div>
            <div className="panel-title compact">
              <span className="icon-frame"><RefreshCw size={17} strokeWidth={1.5} /></span>
              <div>
                <h2>后台采集</h2>
                <p>使用已保存且 active 的项目 token 拉取 GitLab issue 和事件。</p>
              </div>
            </div>
          </div>
          <button onClick={collect} disabled={pending}>
            <RefreshCw size={16} strokeWidth={1.5} />
            手动采集
          </button>
        </div>
        <div className="project-list">
          {projects.map((project) => (
            <div className="project-item" key={project.id}>
              <div>
                <strong>{project.path_with_namespace ?? project.name ?? project.id}</strong>
                <span>#{project.id} · {project.active ? 'active' : 'disabled'} · {project.token_mask || 'no token'}</span>
                {project.last_error && <span className="error-text">{project.last_error}</span>}
              </div>
              <input
                value={tokenDrafts[project.id] ?? ''}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setTokenDrafts((prev) => ({ ...prev, [project.id]: value }));
                }}
                placeholder="新 token"
                type="password"
              />
              <button onClick={() => updateToken(project)} disabled={pending || !tokenDrafts[project.id]?.trim()}>
                <KeyRound size={16} strokeWidth={1.5} />
                更新 token
              </button>
              <button
                onClick={() => run(async () => {
                  await readJson(`/api/projects/${encodeURIComponent(project.id)}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ active: project.active !== 1 })
                  });
                })}
                disabled={pending}
              >
                <Power size={16} strokeWidth={1.5} />
                {project.active ? '停用' : '启用'}
              </button>
              <button
                className="danger"
                onClick={() => run(async () => {
                  await readJson(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
                })}
                disabled={pending}
              >
                <Trash2 size={16} strokeWidth={1.5} />
                删除
              </button>
            </div>
          ))}
          {projects.length === 0 && (
            <div className="empty">
              <Plus size={17} strokeWidth={1.5} />
              暂无项目。先添加 GitLab 项目 ID、路径和 token。
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
