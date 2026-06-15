import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/lib/schema.ts';
import { getSyncState, shouldReplayForIssueLinking } from '../src/lib/agentrix/sync-state.ts';

test('shouldReplayForIssueLinking replays previously synced unlinked tasks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-sync-state-'));
  try {
    const db = new Database(join(dir, 'dashboard.db'));
    migrate(db);
    db.prepare(`
      insert into agentrix_tasks (task_id, runner_id, last_sequence, collected_at)
      values (?, ?, ?, ?)
    `).run('task-unlinked', 'runner-1', 10, 1000);
    db.prepare(`
      insert into agentrix_sync_state (
        runner_id, source, source_path, task_id, last_sequence, last_synced_at
      ) values (?, 'agentrix_sqlite', ?, ?, ?, ?)
    `).run('runner-1', '/tmp/data.bin', 'task-unlinked', 10, 1000);

    const syncState = getSyncState(db, 'runner-1', '/tmp/data.bin');
    assert.equal(syncState?.task_id, 'task-unlinked');
    assert.equal(shouldReplayForIssueLinking(db, syncState), true);

    db.prepare('update agentrix_tasks set project_id = ?, issue_iid = ? where task_id = ?')
      .run('gitlab:huilian/wandou-kanban', 1, 'task-unlinked');
    assert.equal(shouldReplayForIssueLinking(db, syncState), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
