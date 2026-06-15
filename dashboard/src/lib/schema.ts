import type { Database } from 'better-sqlite3';

const statements = [
  `create table if not exists projects (
    id text primary key,
    name text,
    path_with_namespace text,
    provider text,
    token text,
    active integer not null default 1,
    last_success_run_id integer,
    last_success_at integer,
    last_error text,
    created_at integer,
    updated_at integer
  )`,
  `create table if not exists collection_runs (
    id integer primary key autoincrement,
    project_id text not null,
    started_at integer not null,
    finished_at integer,
    status text not null,
    issue_count integer,
    error text
  )`,
  `create table if not exists issues (
    project_id text not null,
    iid integer not null,
    title text,
    author text,
    assignee text,
    state text,
    current_flow_stage text,
    issue_type text,
    priority text,
    created_at integer,
    first_closed_at integer,
    final_closed_at integer,
    first_close_duration_sec integer,
    reopen_duration_sec integer,
    reopen_count integer default 0,
    issue_flow_gate_count integer default 0,
    agentrix_user_message_count integer default 0,
    agentrix_question_answer_count integer default 0,
    human_intervention_total integer default 0,
    automation_action_count integer default 0,
    input_tokens integer default 0,
    output_tokens integer default 0,
    cache_creation_input_tokens integer default 0,
    cache_read_input_tokens integer default 0,
    token_cost_usd real default 0,
    stage_triage_sec integer default 0,
    stage_plan_sec integer default 0,
    stage_build_sec integer default 0,
    stage_clarify_sec integer default 0,
    stage_approve_sec integer default 0,
    stage_unknown_sec integer default 0,
    is_bug_ever integer default 0,
    data_quality text,
    updated_at integer,
    collected_at integer,
    primary key (project_id, iid)
  )`,
  `create table if not exists agentrix_raw_events (
    source text not null,
    source_event_id text not null,
    runner_id text,
    task_id text,
    session_id text,
    sequence integer,
    event_type text,
    event_subtype text,
    actor_type text,
    actor_id text,
    occurred_at integer,
    payload_json text,
    ingested_at integer,
    primary key (source, source_event_id)
  )`,
  `create table if not exists agentrix_tasks (
    task_id text primary key,
    run_id text,
    runner_id text,
    session_id text,
    project_id text,
    issue_iid integer,
    issue_ref text,
    action text,
    task_kind text,
    title text,
    status text,
    detail_url text,
    input_tokens integer default 0,
    output_tokens integer default 0,
    cache_creation_input_tokens integer default 0,
    cache_read_input_tokens integer default 0,
    cost_usd real default 0,
    duration_sec integer,
    source_workspace text,
    last_sequence integer,
    created_at integer,
    completed_at integer,
    collected_at integer,
    raw_json text
  )`,
  `create table if not exists agentrix_human_events (
    id text primary key,
    source text,
    source_event_id text,
    task_id text,
    project_id text,
    issue_iid integer,
    event_type text,
    event_subtype text,
    actor text,
    actor_id text,
    created_at integer,
    raw_json text
  )`,
  `create table if not exists agentrix_sync_state (
    runner_id text not null,
    source text not null,
    source_path text not null,
    task_id text,
    last_sequence integer,
    last_event_id text,
    last_mtime integer,
    last_synced_at integer,
    last_error text,
    primary key (runner_id, source, source_path)
  )`,
  `create index if not exists idx_issues_created_at on issues(created_at)`,
  `create index if not exists idx_agentrix_raw_task on agentrix_raw_events(task_id)`,
  `create index if not exists idx_agentrix_human_task on agentrix_human_events(task_id)`
];

export function migrate(db: Database) {
  const run = db.transaction(() => {
    for (const statement of statements) {
      db.exec(statement);
    }
  });
  run();
}
