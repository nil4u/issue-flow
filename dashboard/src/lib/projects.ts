import type { DashboardDatabase } from './db.ts';
import { type DashboardProjectConfig, loadAppConfig } from './config.ts';

export type ProjectConfigInput = {
  id: string | number;
  name?: string | null;
  pathWithNamespace: string;
  token?: string | null;
  active?: boolean;
};

export type ProjectConfigRow = {
  id: string;
  name: string | null;
  path_with_namespace: string | null;
  provider: string | null;
  active: number;
  token_mask: string;
  last_success_at: number | null;
  last_error: string | null;
};

export type ProjectOption = {
  id: string;
  name: string;
};

function nowMs() {
  return Date.now();
}

export function maskToken(token: string | null | undefined) {
  if (!token) return '';
  const tail = token.slice(-4);
  return `****${tail}`;
}

export function upsertProjectConfig(db: DashboardDatabase, input: ProjectConfigInput) {
  const id = String(input.id).trim();
  const pathWithNamespace = input.pathWithNamespace.trim();
  if (!id) throw new Error('Project id is required');
  if (!pathWithNamespace) throw new Error('Project path is required');
  const timestamp = nowMs();
  const token = input.token?.trim() || null;
  db.prepare(`
    insert into projects (
      id, name, path_with_namespace, provider, token, active, created_at, updated_at
    ) values (
      @id, @name, @pathWithNamespace, 'gitlab', @token, @active, @now, @now
    )
    on conflict(id) do update set
      name = excluded.name,
      path_with_namespace = excluded.path_with_namespace,
      provider = 'gitlab',
      token = case when @tokenProvided = 1 then excluded.token else projects.token end,
      active = excluded.active,
      updated_at = excluded.updated_at
  `).run({
    id,
    name: input.name?.trim() || pathWithNamespace.split('/').at(-1) || id,
    pathWithNamespace,
    token,
    tokenProvided: token ? 1 : 0,
    active: input.active === false ? 0 : 1,
    now: timestamp
  });
}

export function listProjectConfigs(db: DashboardDatabase): ProjectConfigRow[] {
  const rows = db.prepare(`
    select
      id, name, path_with_namespace, provider, active, token,
      last_success_at, last_error
    from projects
    order by coalesce(path_with_namespace, name, id)
  `).all() as Array<ProjectConfigRow & { token: string | null }>;
  return rows.map(({ token, ...row }) => ({
    ...row,
    token_mask: maskToken(token)
  }));
}

export function listProjectOptions(db: DashboardDatabase): ProjectOption[] {
  const rows = db.prepare(`
    select id, coalesce(path_with_namespace, name, id) as name
    from projects
    where active = 1
    order by name
  `).all() as ProjectOption[];
  return rows;
}

export function readConfiguredProjects(db: DashboardDatabase): DashboardProjectConfig[] {
  const appConfig = loadAppConfig();
  const rows = db.prepare(`
    select id, name, path_with_namespace, token
    from projects
    where active = 1
      and token is not null
      and token != ''
      and path_with_namespace is not null
      and path_with_namespace != ''
    order by coalesce(path_with_namespace, name, id)
  `).all() as Array<{
    id: string;
    name: string | null;
    path_with_namespace: string;
    token: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name || row.path_with_namespace.split('/').at(-1) || row.id,
    provider: 'gitlab',
    baseUrl: appConfig.gitlab.baseUrl,
    pathWithNamespace: row.path_with_namespace,
    token: row.token
  }));
}

export function setProjectActive(db: DashboardDatabase, projectId: string, active: boolean) {
  db.prepare(`
    update projects
    set active = ?, updated_at = ?
    where id = ?
  `).run(active ? 1 : 0, nowMs(), projectId);
}

export function deleteProjectConfig(db: DashboardDatabase, projectId: string) {
  db.prepare('delete from projects where id = ?').run(projectId);
}

export function recordProjectCollectionSuccess(db: DashboardDatabase, projectId: string, issueCount: number) {
  const run = db.prepare(`
    insert into collection_runs (project_id, started_at, finished_at, status, issue_count)
    values (?, ?, ?, 'success', ?)
  `);
  const now = nowMs();
  const result = run.run(projectId, now, now, issueCount);
  db.prepare(`
    update projects
    set last_success_run_id = ?, last_success_at = ?, last_error = null, updated_at = ?
    where id = ?
  `).run(result.lastInsertRowid, now, now, projectId);
}

export function recordProjectCollectionError(db: DashboardDatabase, projectId: string, error: string) {
  const now = nowMs();
  db.prepare(`
    insert into collection_runs (project_id, started_at, finished_at, status, error)
    values (?, ?, ?, 'error', ?)
  `).run(projectId, now, now, error);
  db.prepare(`
    update projects
    set last_error = ?, updated_at = ?
    where id = ?
  `).run(error, now, projectId);
}
