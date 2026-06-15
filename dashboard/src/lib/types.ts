export type FlowStage = 'triage' | 'plan' | 'build' | 'clarify' | 'approve' | 'unknown' | 'ignored';

export type LabelEventAction = 'add' | 'remove';

export type IssueLabelEvent = {
  labelName: string;
  action: LabelEventAction;
  createdAt: number;
};

export type IssueStateEvent = {
  state: 'closed' | 'reopened' | string;
  createdAt: number;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
};

export type AgentrixSource = 'agentrix_sqlite';

export type AgentrixEventInput = {
  source: AgentrixSource;
  sourceEventId: string;
  taskId: string;
  sessionId?: string | null;
  sequence?: number | null;
  eventType: string;
  eventSubtype?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  occurredAt: number;
  payload: unknown;
};

export type AgentrixHumanEventInput = {
  id: string;
  source: AgentrixSource;
  sourceEventId: string;
  taskId: string;
  eventType: 'user_message' | 'question_answer' | 'other';
  eventSubtype?: string | null;
  actor?: string | null;
  actorId?: string | null;
  createdAt: number;
  rawJson: string;
};

export type AgentrixBatchInput = {
  runnerId: string;
  source: AgentrixSource;
  taskId: string;
  sessionId?: string | null;
  projectId?: string | null;
  projectPathWithNamespace?: string | null;
  issueIid?: number | null;
  issueRef?: string | null;
  action?: string | null;
  taskKind?: string | null;
  title?: string | null;
  status?: string | null;
  detailUrl?: string | null;
  sourceWorkspace?: string | null;
  events: Array<{
    sourceEventId: string;
    sequence?: number | null;
    eventType: string;
    eventSubtype?: string | null;
    actorType?: string | null;
    actorId?: string | null;
    occurredAt: number;
    payload: unknown;
  }>;
};
