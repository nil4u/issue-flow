import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/lib/schema.ts';

test('migration creates dashboard tables and token columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-schema-'));
  const dbPath = join(dir, 'dashboard.db');
  try {
    const db = new Database(dbPath);
    migrate(db);

    const tables = db.prepare("select name from sqlite_master where type = 'table' order by name").all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((row) => row.name).filter((name) => name !== 'sqlite_sequence'), [
      'agentrix_human_events',
      'agentrix_raw_events',
      'agentrix_sync_state',
      'agentrix_tasks',
      'collection_runs',
      'issues',
      'projects'
    ]);

    const issueColumns = db.prepare("pragma table_info('issues')").all() as Array<{ name: string }>;
    assert.ok(issueColumns.some((column) => column.name === 'token_cost_usd'));
    assert.ok(issueColumns.some((column) => column.name === 'input_tokens'));
    assert.ok(issueColumns.some((column) => column.name === 'agentrix_question_answer_count'));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
