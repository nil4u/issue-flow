export const FLOW_STAGES = ['triage', 'plan', 'build', 'clarify', 'approve', 'unknown'] as const;

export type FlowStageKey = (typeof FLOW_STAGES)[number];

export const STAGE_LABELS: Record<FlowStageKey, string> = {
  triage: 'Triage',
  plan: 'Plan',
  build: 'Build',
  clarify: 'Clarify',
  approve: 'Approve',
  unknown: 'Unknown'
};

export const STAGE_DESCRIPTIONS: Record<FlowStageKey, string> = {
  triage: '进入问题池，等待澄清或拆解',
  plan: '生成或确认技术方案',
  build: 'Agentrix 执行开发任务',
  clarify: '等待人工补充上下文',
  approve: '等待人工确认关键动作',
  unknown: '缺少可识别 flow 标签或历史阶段'
};

export const STAGE_COLORS: Record<FlowStageKey, string> = {
  triage: '#4f46e5',
  plan: '#007a8a',
  build: '#159163',
  clarify: '#b76b12',
  approve: '#c3382c',
  unknown: '#697386'
};

export const STAGE_SECONDS_FIELD: Record<FlowStageKey, string> = {
  triage: 'stage_triage_sec',
  plan: 'stage_plan_sec',
  build: 'stage_build_sec',
  clarify: 'stage_clarify_sec',
  approve: 'stage_approve_sec',
  unknown: 'stage_unknown_sec'
};
