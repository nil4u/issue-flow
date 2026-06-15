import type { DashboardDatabase } from '../db.ts';

export function getSyncState(db: DashboardDatabase, runnerId: string, sourcePath: string) {
  return db.prepare(`
    select task_id, last_sequence, last_event_id, last_mtime
    from agentrix_sync_state
    where runner_id = ? and source = 'agentrix_sqlite' and source_path = ?
  `).get(runnerId, sourcePath) as
    | { task_id: string | null; last_sequence: number | null; last_event_id: string | null; last_mtime: number | null }
    | undefined;
}

export function shouldReplayForIssueLinking(
  db: DashboardDatabase,
  syncState?: { task_id: string | null } | null
) {
  if (!syncState?.task_id) return false;
  const row = db
    .prepare('select project_id, issue_iid from agentrix_tasks where task_id = ?')
    .get(syncState.task_id) as { project_id: string | null; issue_iid: number | null } | undefined;
  return Boolean(row && (!row.project_id || row.issue_iid == null));
}

export function updateSyncState(
  db: DashboardDatabase,
  input: {
    runnerId: string;
    sourcePath: string;
    taskId?: string | null;
    lastSequence?: number | null;
    lastEventId?: string | null;
    lastMtime?: number | null;
    lastError?: string | null;
  }
) {
  db.prepare(`
    insert into agentrix_sync_state (
      runner_id, source, source_path, task_id, last_sequence, last_event_id,
      last_mtime, last_synced_at, last_error
    ) values (
      @runnerId, 'agentrix_sqlite', @sourcePath, @taskId, @lastSequence, @lastEventId,
      @lastMtime, @now, @lastError
    )
    on conflict(runner_id, source, source_path) do update set
      task_id = excluded.task_id,
      last_sequence = excluded.last_sequence,
      last_event_id = excluded.last_event_id,
      last_mtime = excluded.last_mtime,
      last_synced_at = excluded.last_synced_at,
      last_error = excluded.last_error
  `).run({
    ...input,
    taskId: input.taskId ?? null,
    lastSequence: input.lastSequence ?? null,
    lastEventId: input.lastEventId ?? null,
    lastMtime: input.lastMtime ?? null,
    lastError: input.lastError ?? null,
    now: Date.now()
  });
}
