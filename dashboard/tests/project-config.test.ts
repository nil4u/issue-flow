import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/lib/schema.ts';
import {
  listProjectConfigs,
  readConfiguredProjects,
  setProjectActive,
  upsertProjectConfig
} from '../src/lib/projects.ts';
import { resetAppConfigCache } from '../src/lib/config.ts';

test('project config is stored in dashboard database and exposes masked tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-project-config-'));
  const previousCwd = process.cwd();
  try {
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'app.yml'), 'gitlab:\n  base_url: https://git.lianjia.com\n');
    process.chdir(dir);
    resetAppConfigCache();

    const db = new Database(join(dir, 'dashboard.db'));
    migrate(db);

    upsertProjectConfig(db, {
      id: 43371,
      name: 'wandou-kanban',
      pathWithNamespace: 'huilian/wandou-kanban',
      token: 'test-token-1234567890'
    });

    assert.deepEqual(listProjectConfigs(db), [
      {
        id: '43371',
        name: 'wandou-kanban',
        path_with_namespace: 'huilian/wandou-kanban',
        provider: 'gitlab',
        active: 1,
        token_mask: '****7890',
        last_success_at: null,
        last_error: null
      }
    ]);

    assert.deepEqual(readConfiguredProjects(db), [
      {
        id: '43371',
        name: 'wandou-kanban',
        provider: 'gitlab',
        baseUrl: 'https://git.lianjia.com',
        pathWithNamespace: 'huilian/wandou-kanban',
        token: 'test-token-1234567890'
      }
    ]);

    setProjectActive(db, '43371', false);
    assert.deepEqual(readConfiguredProjects(db), []);
  } finally {
    process.chdir(previousCwd);
    resetAppConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
