import type { FlowStage, IssueLabelEvent, IssueStateEvent } from './types.ts';

const supportedFlowStages = new Set(['triage', 'plan', 'build', 'clarify', 'approve']);

export type DerivedIssueInput = {
  createdAt: number;
  labels: string[];
  labelEvents: IssueLabelEvent[];
  stateEvents: IssueStateEvent[];
  now: number;
};

export type DerivedIssueMetrics = {
  current_flow_stage: FlowStage;
  issue_type: string | null;
  priority: string | null;
  first_closed_at: number | null;
  final_closed_at: number | null;
  first_close_duration_sec: number | null;
  reopen_count: number;
  issue_flow_gate_count: number;
  automation_action_count: number;
  human_intervention_total: number;
  stage_triage_sec: number;
  stage_plan_sec: number;
  stage_build_sec: number;
  stage_clarify_sec: number;
  stage_approve_sec: number;
  stage_unknown_sec: number;
  stage_review_sec?: undefined;
  is_bug_ever: 0 | 1;
};

export function parseFlowStage(label: string): FlowStage {
  if (!label.startsWith('flow::')) {
    return 'unknown';
  }
  const stage = label.slice('flow::'.length);
  if (stage === 'review') {
    return 'ignored';
  }
  return supportedFlowStages.has(stage) ? (stage as FlowStage) : 'unknown';
}

export function deriveIssueMetrics(input: DerivedIssueInput): DerivedIssueMetrics {
  const sortedFlowAdds = input.labelEvents
    .filter((event) => event.action === 'add' && event.labelName.startsWith('flow::'))
    .map((event) => ({ ...event, stage: parseFlowStage(event.labelName) }))
    .filter((event) => event.stage !== 'ignored')
    .sort((a, b) => a.createdAt - b.createdAt);

  const stageDurations = {
    stage_triage_sec: 0,
    stage_plan_sec: 0,
    stage_build_sec: 0,
    stage_clarify_sec: 0,
    stage_approve_sec: 0,
    stage_unknown_sec: 0
  };

  for (let index = 0; index < sortedFlowAdds.length; index += 1) {
    const event = sortedFlowAdds[index];
    const next = sortedFlowAdds[index + 1];
    const end = next?.createdAt ?? input.now;
    const duration = Math.max(0, Math.floor((end - event.createdAt) / 1000));
    const key = event.stage === 'unknown' ? 'stage_unknown_sec' : `stage_${event.stage}_sec`;
    if (key in stageDurations) {
      stageDurations[key as keyof typeof stageDurations] += duration;
    }
  }

  const closedEvents = input.stateEvents
    .filter((event) => event.state === 'closed')
    .sort((a, b) => a.createdAt - b.createdAt);
  const reopenCount = input.stateEvents.filter((event) => event.state === 'reopened').length;
  const firstClosedAt = closedEvents[0]?.createdAt ?? null;
  const finalClosedAt = closedEvents.at(-1)?.createdAt ?? null;

  const issueFlowGateCount = input.labelEvents.filter((event) => {
    return event.action === 'add' && (event.labelName === 'flow::clarify' || event.labelName === 'flow::approve');
  }).length;
  const automationActionCount = input.labelEvents.filter((event) => {
    return event.action === 'add' && (event.labelName === 'flow::plan' || event.labelName === 'flow::build');
  }).length;

  const currentFlowStage = parseFlowStage(input.labels.find((label) => label.startsWith('flow::')) ?? '');
  const issueType = input.labels.find((label) => label.startsWith('type::'))?.slice('type::'.length) ?? null;
  const priority = input.labels.find((label) => label.startsWith('priority::'))?.slice('priority::'.length) ?? null;

  return {
    current_flow_stage: currentFlowStage === 'ignored' ? 'unknown' : currentFlowStage,
    issue_type: issueType,
    priority,
    first_closed_at: firstClosedAt,
    final_closed_at: finalClosedAt,
    first_close_duration_sec: firstClosedAt == null ? null : Math.max(0, Math.floor((firstClosedAt - input.createdAt) / 1000)),
    reopen_count: reopenCount,
    issue_flow_gate_count: issueFlowGateCount,
    automation_action_count: automationActionCount,
    human_intervention_total: issueFlowGateCount,
    ...stageDurations,
    is_bug_ever: input.labels.includes('type::bug') || input.labelEvents.some((event) => event.labelName === 'type::bug') ? 1 : 0
  };
}
