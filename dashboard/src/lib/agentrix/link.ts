import type { DashboardDatabase } from '../db.ts';
import type { AgentrixBatchInput } from '../types.ts';

export type AgentrixIssueReference = {
  projectPathWithNamespace?: string | null;
  issueIid?: number | null;
  issueRef?: string | null;
  action?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function collectText(value: unknown, parts: string[]) {
  if (typeof value === 'string') {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, parts);
    }
    return;
  }
  const record = asRecord(value);
  for (const nested of Object.values(record)) {
    collectText(nested, parts);
  }
}

export function textFromAgentrixPayload(payload: unknown) {
  const parts: string[] = [];
  collectText(asRecord(payload).message ?? payload, parts);
  return parts.join('\n');
}

function firstNumber(patterns: RegExp[], text: string) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

function firstPath(patterns: RegExp[], text: string) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim().replace(/[.,;，。；]+$/, '');
    if (value && value.includes('/') && !value.startsWith('/')) return value;
  }
  return null;
}

function inferAction(text: string) {
  const lower = text.toLowerCase();
  if (lower.includes('build pr') || lower.includes('build mr') || text.includes('实现当前 issue')) return 'build';
  if (lower.includes('plan pr') || lower.includes('plan mr') || text.includes('生成方案')) return 'plan';
  if (lower.includes('triage') || text.includes('分类打标签')) return 'triage';
  if (lower.includes('clarify') || text.includes('澄清')) return 'clarify';
  if (lower.includes('approve') || text.includes('审批')) return 'approve';
  return null;
}

export function extractIssueReferenceFromText(text: string): AgentrixIssueReference {
  const issueIid = firstNumber(
    [
      /\bNumber:\s*#?(\d+)\b/i,
      /\bGitLab\s+issue\s+#?(\d+)\b/i,
      /\bSource\s+issue\s+#?(\d+)\b/i,
      /\bIssue\s*#(\d+)\b/i
    ],
    text
  );
  const projectPathWithNamespace = firstPath(
    [
      /\bProject:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+)/i,
      /\bpath_with_namespace:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+)/i,
      /\bGitLab\s+issue\s+#?\d+\s+in\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+)/i,
      /\bin\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+):/i
    ],
    text
  );

  return {
    issueIid,
    projectPathWithNamespace,
    issueRef: projectPathWithNamespace && issueIid ? `${projectPathWithNamespace}#${issueIid}` : null,
    action: inferAction(text)
  };
}

export function inferIssueReferenceFromPayloads(payloads: unknown[]): AgentrixIssueReference {
  const text = payloads.map(textFromAgentrixPayload).join('\n\n');
  return extractIssueReferenceFromText(text);
}

function projectPathFromIssueRef(issueRef?: string | null) {
  const match = issueRef?.match(/^(.+)#\d+$/);
  return match?.[1] ?? null;
}

export function resolveAgentrixBatchIssue(db: DashboardDatabase, batch: AgentrixBatchInput) {
  const projectPath = batch.projectPathWithNamespace ?? projectPathFromIssueRef(batch.issueRef);
  let projectId = batch.projectId ?? null;

  if (!projectId && projectPath) {
    const row = db
      .prepare('select id from projects where path_with_namespace = ? order by active desc, updated_at desc limit 1')
      .get(projectPath) as { id: string } | undefined;
    projectId = row?.id ?? null;
  }

  if (!projectId && batch.issueIid != null) {
    const rows = db.prepare('select id from projects where active = 1 order by updated_at desc').all() as Array<{ id: string }>;
    if (rows.length === 1) {
      projectId = rows[0].id;
    }
  }

  return {
    projectId,
    issueIid: batch.issueIid ?? null,
    issueRef: batch.issueRef ?? (projectPath && batch.issueIid ? `${projectPath}#${batch.issueIid}` : null)
  };
}
