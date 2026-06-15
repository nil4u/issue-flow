import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readAgentrixDataBin } from '../src/lib/agentrix/sqlite.ts';

test('readAgentrixDataBin parses task_event rows from data.bin sqlite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-agentrix-sqlite-'));
  const dbPath = join(dir, 'data.bin');
  try {
    const db = new Database(dbPath);
    db.exec(`
      create table task_event (
        event_id text primary key,
        task_id text not null,
        chat_id text not null,
        sequence integer,
        event_type text not null,
        event_data text not null,
        created_at text not null
      );
      create table task_agent_session (
        agent_id text primary key,
        task_id text,
        session_id text not null,
        last_sequence integer,
        updated_at text not null
      );
    `);
    db.prepare('insert into task_agent_session (agent_id, task_id, session_id, last_sequence, updated_at) values (?, ?, ?, ?, ?)')
      .run('agent-1', 'task-1', 'session-1', 1, '2026-06-15T00:00:00.000Z');
    db.prepare('insert into task_event (event_id, task_id, chat_id, sequence, event_type, event_data, created_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run('event-1', 'task-1', 'chat-1', 1, 'task-message', JSON.stringify({ senderType: 'human' }), '2026-06-15T00:00:01.000Z');
    db.close();

    const snapshot = readAgentrixDataBin({ dbPath, sourcePath: dbPath, runnerId: 'runner-1' });
    assert.equal(snapshot.taskId, 'task-1');
    assert.equal(snapshot.sessionId, 'session-1');
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].sourceEventId, 'event-1');
    assert.equal(snapshot.events[0].actorType, 'human');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
