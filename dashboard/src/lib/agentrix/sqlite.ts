import Database from 'better-sqlite3';
import { getPayloadMessageType, getPayloadSenderType } from './classify.ts';
import { inferIssueReferenceFromPayloads } from './link.ts';
import type { AgentrixBatchInput } from '../types.ts';

type ReadInput = {
  dbPath: string;
  sourcePath: string;
  runnerId: string;
  afterSequence?: number;
};

type TaskEventRow = {
  event_id: string;
  task_id: string;
  chat_id: string;
  sequence: number | null;
  event_type: string;
  event_data: string;
  created_at: string;
};

type SessionRow = {
  task_id: string | null;
  session_id: string;
  last_sequence: number | null;
};

function parseEventData(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toMillis(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function readAgentrixDataBin(input: ReadInput): AgentrixBatchInput {
  const db = new Database(input.dbPath, { readonly: true, fileMustExist: true });
  try {
    const session = db.prepare('select task_id, session_id, last_sequence from task_agent_session limit 1').get() as SessionRow | undefined;
    const rows = db
      .prepare(`
        select event_id, task_id, chat_id, sequence, event_type, event_data, created_at
        from task_event
        where coalesce(sequence, 0) > @afterSequence
        order by coalesce(sequence, 0), created_at
      `)
      .all({ afterSequence: input.afterSequence ?? -1 }) as TaskEventRow[];
    const taskId = session?.task_id ?? rows[0]?.task_id ?? input.sourcePath.split('/').at(-3) ?? 'unknown-task';
    const events = rows.map((row) => {
      const payload = parseEventData(row.event_data);
      const messageType = getPayloadMessageType(payload);
      const senderType = getPayloadSenderType(payload);
      return {
        sourceEventId: row.event_id,
        sequence: row.sequence,
        eventType: row.event_type,
        eventSubtype: messageType,
        actorType: senderType,
        occurredAt: toMillis(row.created_at),
        payload
      };
    });
    const reference = inferIssueReferenceFromPayloads(events.map((event) => event.payload));

    return {
      runnerId: input.runnerId,
      source: 'agentrix_sqlite',
      taskId,
      sessionId: session?.session_id ?? null,
      sourceWorkspace: input.sourcePath,
      ...reference,
      events
    };
  } finally {
    db.close();
  }
}
