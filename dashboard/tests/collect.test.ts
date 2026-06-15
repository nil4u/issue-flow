import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { collectGitLabProject } from '../src/lib/collect.ts';
import { migrate } from '../src/lib/schema.ts';

test('collectGitLabProject backfills created_at for an existing Agentrix shell issue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-collect-backfill-'));
  try {
    const db = new Database(join(dir, 'dashboard.db'));
    migrate(db);
    db.prepare(`
      insert into issues (
        project_id, iid, title, created_at, agentrix_user_message_count,
        agentrix_question_answer_count, human_intervention_total
      ) values (?, ?, ?, null, ?, ?, ?)
    `).run('gitlab:huilian/wandou-kanban', 3, 'Shell title', 1, 1, 2);

    const createdAt = '2026-06-15T08:30:00.000Z';
    await collectGitLabProject(db, {
      projectId: 'gitlab:huilian/wandou-kanban',
      projectName: 'wandou-kanban',
      projectPath: 'huilian/wandou-kanban',
      client: {
        listIssues: async () => [
          {
            iid: 3,
            title: 'GitLab title',
            state: 'opened',
            created_at: createdAt,
            labels: ['type::feature', 'flow::build'],
            author: { username: 'alice' },
            assignee: null
          }
        ],
        listLabelEvents: async () => [],
        listStateEvents: async () => []
      } as any
    });

    const row = db.prepare(`
      select title, created_at, human_intervention_total
      from issues
      where project_id = ? and iid = ?
    `).get('gitlab:huilian/wandou-kanban', 3) as {
      title: string;
      created_at: number | null;
      human_intervention_total: number;
    };

    assert.equal(row.title, 'GitLab title');
    assert.equal(row.created_at, Date.parse(createdAt));
    assert.equal(row.human_intervention_total, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
