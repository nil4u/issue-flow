import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgentrixEvents, extractTokenUsage } from '../src/lib/agentrix/classify.ts';

test('extractTokenUsage reads modelUsage and total cost from data.bin payloads', () => {
  const usage = extractTokenUsage({
    message: {
      total_cost_usd: 1.75,
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 10,
          cacheReadInputTokens: 30,
          costUSD: 0.75
        },
        'claude-opus-4-8': {
          inputTokens: 200,
          outputTokens: 80,
          cacheCreationInputTokens: 40,
          cacheReadInputTokens: 60,
          costUSD: 1
        }
      }
    }
  });

  assert.deepEqual(usage, {
    inputTokens: 300,
    outputTokens: 100,
    cacheCreationInputTokens: 50,
    cacheReadInputTokens: 90,
    costUsd: 1.75
  });
});

test('classifyAgentrixEvents counts user messages and question answers', () => {
  const result = classifyAgentrixEvents([
    {
      source: 'agentrix_sqlite',
      sourceEventId: 'e1',
      taskId: 'task-1',
      sequence: 1,
      eventType: 'task-message',
      eventSubtype: 'ask_user',
      actorType: 'agent',
      occurredAt: 1000,
      payload: { messageType: 'ask_user', senderType: 'agent' }
    },
    {
      source: 'agentrix_sqlite',
      sourceEventId: 'e2',
      taskId: 'task-1',
      sequence: 2,
      eventType: 'task-message',
      actorType: 'human',
      occurredAt: 2000,
      payload: { senderType: 'human' }
    },
    {
      source: 'agentrix_sqlite',
      sourceEventId: 'e3',
      taskId: 'task-1',
      sequence: 3,
      eventType: 'task-message',
      actorType: 'human',
      occurredAt: 3000,
      payload: { senderType: 'human' }
    }
  ]);

  assert.equal(result.userMessageCount, 2);
  assert.equal(result.questionAnswerCount, 1);
  assert.deepEqual(result.humanEvents.map((event) => event.eventType), ['user_message', 'question_answer', 'user_message']);
});
