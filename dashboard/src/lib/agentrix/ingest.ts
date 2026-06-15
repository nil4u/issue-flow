import type { DashboardDatabase } from '../db.ts';
import { recomputeIssueAgentrixMetrics, upsertIssueShell } from '../db.ts';
import type { AgentrixBatchInput, AgentrixEventInput } from '../types.ts';
import { classifyAgentrixEvents } from './classify.ts';
import { resolveAgentrixBatchIssue } from './link.ts';

function payloadJson(payload: unknown) {
  return JSON.stringify(payload ?? {});
}

export function ingestAgentrixBatch(db: DashboardDatabase, batch: AgentrixBatchInput) {
  if (batch.source !== 'agentrix_sqlite') {
    throw new Error(`Unsupported Agentrix source: ${batch.source}`);
  }
  if (!batch.runnerId || !batch.taskId || !Array.isArray(batch.events)) {
    throw new Error('Invalid Agentrix ingest batch');
  }

  const normalizedEvents: AgentrixEventInput[] = batch.events.map((event) => ({
    source: batch.source,
    sourceEventId: event.sourceEventId,
    taskId: batch.taskId,
    sessionId: batch.sessionId ?? null,
    sequence: event.sequence ?? null,
    eventType: event.eventType,
    eventSubtype: event.eventSubtype ?? null,
    actorType: event.actorType ?? null,
    actorId: event.actorId ?? null,
    occurredAt: event.occurredAt,
    payload: event.payload
  }));
  const resolvedIssue = resolveAgentrixBatchIssue(db, batch);

  const insertedEvents: AgentrixEventInput[] = [];
  const run = db.transaction(() => {
    if (resolvedIssue.projectId && resolvedIssue.issueIid != null) {
      upsertIssueShell(db, {
        projectId: resolvedIssue.projectId,
        iid: resolvedIssue.issueIid,
        title: batch.title ?? batch.issueRef ?? null
      });
    }

    const insertRaw = db.prepare(`
      insert or ignore into agentrix_raw_events (
        source, source_event_id, runner_id, task_id, session_id, sequence,
        event_type, event_subtype, actor_type, actor_id, occurred_at, payload_json, ingested_at
      ) values (
        @source, @sourceEventId, @runnerId, @taskId, @sessionId, @sequence,
        @eventType, @eventSubtype, @actorType, @actorId, @occurredAt, @payloadJson, @ingestedAt
      )
    `);

    for (const event of normalizedEvents) {
      const result = insertRaw.run({
        ...event,
        runnerId: batch.runnerId,
        payloadJson: payloadJson(event.payload),
        ingestedAt: Date.now()
      });
      if (result.changes > 0) {
        insertedEvents.push(event);
      }
    }

    db.prepare(`
      insert into agentrix_tasks (
        task_id, runner_id, session_id, project_id, issue_iid, issue_ref, action,
        task_kind, title, status, detail_url, source_workspace, last_sequence,
        collected_at, raw_json
      ) values (
        @taskId, @runnerId, @sessionId, @projectId, @issueIid, @issueRef, @action,
        @taskKind, @title, @status, @detailUrl, @sourceWorkspace, @lastSequence,
        @now, @rawJson
      )
      on conflict(task_id) do update set
        runner_id = excluded.runner_id,
        session_id = coalesce(excluded.session_id, agentrix_tasks.session_id),
        project_id = coalesce(excluded.project_id, agentrix_tasks.project_id),
        issue_iid = coalesce(excluded.issue_iid, agentrix_tasks.issue_iid),
        issue_ref = coalesce(excluded.issue_ref, agentrix_tasks.issue_ref),
        action = coalesce(excluded.action, agentrix_tasks.action),
        task_kind = coalesce(excluded.task_kind, agentrix_tasks.task_kind),
        title = coalesce(excluded.title, agentrix_tasks.title),
        status = coalesce(excluded.status, agentrix_tasks.status),
        detail_url = coalesce(excluded.detail_url, agentrix_tasks.detail_url),
        source_workspace = coalesce(excluded.source_workspace, agentrix_tasks.source_workspace),
        last_sequence = max(coalesce(agentrix_tasks.last_sequence, 0), coalesce(excluded.last_sequence, 0)),
        collected_at = excluded.collected_at,
        raw_json = excluded.raw_json
    `).run({
      taskId: batch.taskId,
      runnerId: batch.runnerId,
      sessionId: batch.sessionId ?? null,
      projectId: resolvedIssue.projectId,
      issueIid: resolvedIssue.issueIid,
      issueRef: resolvedIssue.issueRef,
      action: batch.action ?? null,
      taskKind: batch.taskKind ?? null,
      title: batch.title ?? null,
      status: batch.status ?? null,
      detailUrl: batch.detailUrl ?? null,
      sourceWorkspace: batch.sourceWorkspace ?? null,
      lastSequence: Math.max(0, ...normalizedEvents.map((event) => event.sequence ?? 0)),
      now: Date.now(),
      rawJson: JSON.stringify({ ...batch, events: undefined })
    });

    if (insertedEvents.length > 0) {
      const classified = classifyAgentrixEvents(insertedEvents);
      const insertHuman = db.prepare(`
        insert or ignore into agentrix_human_events (
          id, source, source_event_id, task_id, project_id, issue_iid,
          event_type, event_subtype, actor, actor_id, created_at, raw_json
        ) values (
          @id, @source, @sourceEventId, @taskId, @projectId, @issueIid,
          @eventType, @eventSubtype, @actor, @actorId, @createdAt, @rawJson
        )
      `);
      for (const event of classified.humanEvents) {
        insertHuman.run({
          ...event,
          projectId: resolvedIssue.projectId,
          issueIid: resolvedIssue.issueIid
        });
      }

      db.prepare(`
        update agentrix_tasks set
          input_tokens = input_tokens + @inputTokens,
          output_tokens = output_tokens + @outputTokens,
          cache_creation_input_tokens = cache_creation_input_tokens + @cacheCreationInputTokens,
          cache_read_input_tokens = cache_read_input_tokens + @cacheReadInputTokens,
          cost_usd = cost_usd + @costUsd,
          collected_at = @now
        where task_id = @taskId
      `).run({
        taskId: batch.taskId,
        ...classified.usage,
        now: Date.now()
      });
    }

    if (resolvedIssue.projectId && resolvedIssue.issueIid != null) {
      recomputeIssueAgentrixMetrics(db, resolvedIssue.projectId, resolvedIssue.issueIid);
    }
  });

  run();
  return { insertedEvents: insertedEvents.length };
}
