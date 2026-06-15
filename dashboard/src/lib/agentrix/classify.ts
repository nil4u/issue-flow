import type { AgentrixEventInput, AgentrixHumanEventInput, TokenUsage } from '../types.ts';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readNestedPayload(payload: unknown) {
  const root = asRecord(payload);
  const message = asRecord(root.message);
  return { root, message };
}

export function getPayloadMessageType(payload: unknown): string | null {
  const { root, message } = readNestedPayload(payload);
  return (root.messageType as string | undefined) ?? (message.messageType as string | undefined) ?? null;
}

export function getPayloadSenderType(payload: unknown): string | null {
  const { root, message } = readNestedPayload(payload);
  return (root.senderType as string | undefined) ?? (message.senderType as string | undefined) ?? null;
}

export function extractTokenUsage(payload: unknown): TokenUsage {
  const { message } = readNestedPayload(payload);
  const usage = asRecord(message.usage);
  const modelUsage = asRecord(message.modelUsage);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let costUsd = 0;

  for (const model of Object.values(modelUsage)) {
    const modelRecord = asRecord(model);
    inputTokens += toNumber(modelRecord.inputTokens);
    outputTokens += toNumber(modelRecord.outputTokens);
    cacheCreationInputTokens += toNumber(modelRecord.cacheCreationInputTokens);
    cacheReadInputTokens += toNumber(modelRecord.cacheReadInputTokens);
    costUsd += toNumber(modelRecord.costUSD);
  }

  if (inputTokens === 0 && outputTokens === 0 && cacheCreationInputTokens === 0 && cacheReadInputTokens === 0) {
    inputTokens += toNumber(usage.input_tokens);
    outputTokens += toNumber(usage.output_tokens);
    cacheCreationInputTokens += toNumber(usage.cache_creation_input_tokens);
    cacheReadInputTokens += toNumber(usage.cache_read_input_tokens);
  }

  costUsd = Math.max(costUsd, toNumber(message.total_cost_usd));

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    costUsd
  };
}

export function classifyAgentrixEvents(events: AgentrixEventInput[]) {
  const ordered = [...events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.occurredAt - b.occurredAt);
  const humanEvents: AgentrixHumanEventInput[] = [];
  let pendingQuestion = false;
  let userMessageCount = 0;
  let questionAnswerCount = 0;
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: 0
  };

  for (const event of ordered) {
    const messageType = event.eventSubtype ?? getPayloadMessageType(event.payload);
    const senderType = event.actorType ?? getPayloadSenderType(event.payload);
    if (messageType === 'ask_user') {
      pendingQuestion = true;
    }

    const eventUsage = extractTokenUsage(event.payload);
    usage.inputTokens += eventUsage.inputTokens;
    usage.outputTokens += eventUsage.outputTokens;
    usage.cacheCreationInputTokens += eventUsage.cacheCreationInputTokens;
    usage.cacheReadInputTokens += eventUsage.cacheReadInputTokens;
    usage.costUsd += eventUsage.costUsd;

    if (senderType === 'human') {
      userMessageCount += 1;
      humanEvents.push({
        id: `${event.source}:${event.sourceEventId}:user_message`,
        source: event.source,
        sourceEventId: event.sourceEventId,
        taskId: event.taskId,
        eventType: 'user_message',
        eventSubtype: messageType,
        actor: senderType,
        actorId: event.actorId ?? null,
        createdAt: event.occurredAt,
        rawJson: JSON.stringify(event.payload)
      });
      if (pendingQuestion) {
        questionAnswerCount += 1;
        pendingQuestion = false;
        humanEvents.push({
          id: `${event.source}:${event.sourceEventId}:question_answer`,
          source: event.source,
          sourceEventId: event.sourceEventId,
          taskId: event.taskId,
          eventType: 'question_answer',
          eventSubtype: messageType,
          actor: senderType,
          actorId: event.actorId ?? null,
          createdAt: event.occurredAt,
          rawJson: JSON.stringify(event.payload)
        });
      }
    }
  }

  return {
    userMessageCount,
    questionAnswerCount,
    humanEvents,
    usage
  };
}
