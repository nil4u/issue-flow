import type { DashboardDatabase } from './db.ts';
import { deriveIssueMetrics } from './derive.ts';
import type { GitLabClient, GitLabIssue } from './gitlab.ts';
import { recordProjectCollectionSuccess } from './projects.ts';

function toMillis(value?: string | null) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export async function collectGitLabProject(
  db: DashboardDatabase,
  input: {
    projectId: string;
    projectName: string;
    projectPath: string;
    client: GitLabClient;
  }
) {
  const now = Date.now();
  db.prepare(`
    insert into projects (id, name, path_with_namespace, provider, active, updated_at, created_at)
    values (?, ?, ?, 'gitlab', 1, ?, ?)
    on conflict(id) do update set
      name = excluded.name,
      path_with_namespace = excluded.path_with_namespace,
      updated_at = excluded.updated_at
  `).run(input.projectId, input.projectName, input.projectPath, now, now);

  const issues = await input.client.listIssues();
  for (const issue of issues as GitLabIssue[]) {
    const [labelEvents, stateEvents] = await Promise.all([
      input.client.listLabelEvents(issue.iid),
      input.client.listStateEvents(issue.iid)
    ]);
    const createdAt = toMillis(issue.created_at) ?? now;
    const metrics = deriveIssueMetrics({
      createdAt,
      labels: issue.labels ?? [],
      labelEvents: labelEvents.map((event) => ({
        labelName: event.label?.name ?? '',
        action: event.action,
        createdAt: toMillis(event.created_at) ?? now
      })),
      stateEvents: stateEvents.map((event) => ({
        state: event.state,
        createdAt: toMillis(event.created_at) ?? now
      })),
      now
    });

    db.prepare(`
      insert into issues (
        project_id, iid, title, author, assignee, state, current_flow_stage,
        issue_type, priority, created_at, first_closed_at, final_closed_at,
        first_close_duration_sec, reopen_count, issue_flow_gate_count,
        human_intervention_total, automation_action_count, stage_triage_sec,
        stage_plan_sec, stage_build_sec, stage_clarify_sec, stage_approve_sec,
        stage_unknown_sec, is_bug_ever, updated_at, collected_at
      ) values (
        @projectId, @iid, @title, @author, @assignee, @state, @current_flow_stage,
        @issue_type, @priority, @created_at, @first_closed_at, @final_closed_at,
        @first_close_duration_sec, @reopen_count, @issue_flow_gate_count,
        @human_intervention_total, @automation_action_count, @stage_triage_sec,
        @stage_plan_sec, @stage_build_sec, @stage_clarify_sec, @stage_approve_sec,
        @stage_unknown_sec, @is_bug_ever, @now, @now
      )
      on conflict(project_id, iid) do update set
        title = excluded.title,
        author = excluded.author,
        assignee = excluded.assignee,
        state = excluded.state,
        current_flow_stage = excluded.current_flow_stage,
        issue_type = excluded.issue_type,
        priority = excluded.priority,
        created_at = excluded.created_at,
        first_closed_at = excluded.first_closed_at,
        final_closed_at = excluded.final_closed_at,
        first_close_duration_sec = excluded.first_close_duration_sec,
        reopen_count = excluded.reopen_count,
        issue_flow_gate_count = excluded.issue_flow_gate_count,
        human_intervention_total = excluded.issue_flow_gate_count + issues.agentrix_user_message_count + issues.agentrix_question_answer_count,
        automation_action_count = excluded.automation_action_count,
        stage_triage_sec = excluded.stage_triage_sec,
        stage_plan_sec = excluded.stage_plan_sec,
        stage_build_sec = excluded.stage_build_sec,
        stage_clarify_sec = excluded.stage_clarify_sec,
        stage_approve_sec = excluded.stage_approve_sec,
        stage_unknown_sec = excluded.stage_unknown_sec,
        is_bug_ever = excluded.is_bug_ever,
        updated_at = excluded.updated_at,
        collected_at = excluded.collected_at
    `).run({
      projectId: input.projectId,
      iid: issue.iid,
      title: issue.title,
      author: issue.author?.username ?? null,
      assignee: issue.assignee?.username ?? null,
      state: issue.state,
      created_at: createdAt,
      now,
      ...metrics
    });
  }

  recordProjectCollectionSuccess(db, input.projectId, issues.length);
  return { issueCount: issues.length };
}
