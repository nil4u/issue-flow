// @ts-nocheck

import { requireAccessibleRepo } from './repositories.js'

async function requireUser(store, userId) {
  const user = userId ? await store.getUser(userId) : undefined;
  if (!user) {
    const error = new Error('login required');
    error.status = 401;
    error.code = 'login_required';
    throw error;
  }
  return user;
}

async function requireDashboard(store, slug) {
  const dashboard = await store.getDashboardBySlug(String(slug || '').trim());
  if (!dashboard) {
    const error = new Error('dashboard not found');
    error.status = 404;
    error.code = 'dashboard_not_found';
    throw error;
  }
  return dashboard;
}

async function listDashboards({ store, userId = '' }) {
  await requireUser(store, userId);
  return { status: 200, body: { dashboards: await store.listDashboards() } };
}

async function getDashboard({ store, slug, userId = '' }) {
  await requireUser(store, userId);
  return { status: 200, body: { dashboard: await requireDashboard(store, slug) } };
}

async function queryRepositoryDashboardPanel({ store, repoId, slug, panelId, input = {}, userId = '' }) {
  const repo = await requireAccessibleRepo(store, repoId, userId);
  const dashboard = await requireDashboard(store, slug);
  const panel = dashboard.panels.find((item) => item.id === String(panelId || '').trim());
  if (!panel) {
    const error = new Error('dashboard panel not found');
    error.status = 404;
    error.code = 'dashboard_panel_not_found';
    throw error;
  }
  const params = {
    ...(input.params || {}),
    git_server_id: String(repo.gitServerId || ''),
    repository_id: String(repo.projectId || repo.serverRepoId || ''),
  };
  const result = await store.runMetricsQuery(panel.querySql, params);
  return { status: 200, body: { result } };
}

export {
  getDashboard,
  listDashboards,
  queryRepositoryDashboardPanel,
}
