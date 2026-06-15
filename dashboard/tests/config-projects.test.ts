import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppConfig, readProjectsFromEnv, resetAppConfigCache } from '../src/lib/config.ts';

test('loadAppConfig reads GitLab base URL and collection defaults from app.yml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-config-'));
  const previousCwd = process.cwd();
  try {
    mkdirSync(join(dir, 'config'));
    writeFileSync(
      join(dir, 'config', 'app.yml'),
      [
        'gitlab:',
        '  base_url: https://git.lianjia.com/',
        '',
        'collection:',
        '  lookback_days: 90',
        '  keep_raw_runs: 5',
        ''
      ].join('\n')
    );
    process.chdir(dir);
    resetAppConfigCache();

    assert.deepEqual(loadAppConfig(), {
      gitlab: { baseUrl: 'https://git.lianjia.com' },
      collection: { lookbackDays: 90, keepRawRuns: 5 }
    });
  } finally {
    process.chdir(previousCwd);
    resetAppConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readProjectsFromEnv uses numeric GitLab project id and app base URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-projects-'));
  const previousCwd = process.cwd();
  const previousProjects = process.env.DASHBOARD_PROJECTS_JSON;
  try {
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'app.yml'), 'gitlab:\n  base_url: https://git.lianjia.com\n');
    process.chdir(dir);
    resetAppConfigCache();
    process.env.DASHBOARD_PROJECTS_JSON = JSON.stringify([
      {
        id: 12345,
        name: 'wandou-kanban',
        provider: 'gitlab',
        pathWithNamespace: 'huilian/wandou-kanban',
        token: 'pat'
      }
    ]);

    assert.deepEqual(readProjectsFromEnv(), [
      {
        id: '12345',
        name: 'wandou-kanban',
        provider: 'gitlab',
        baseUrl: 'https://git.lianjia.com',
        pathWithNamespace: 'huilian/wandou-kanban',
        token: 'pat'
      }
    ]);
  } finally {
    process.chdir(previousCwd);
    resetAppConfigCache();
    if (previousProjects == null) delete process.env.DASHBOARD_PROJECTS_JSON;
    else process.env.DASHBOARD_PROJECTS_JSON = previousProjects;
    rmSync(dir, { recursive: true, force: true });
  }
});
