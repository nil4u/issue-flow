import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveIssueMetrics, parseFlowStage } from '../src/lib/derive.ts';

test('parseFlowStage supports full-auto states and ignores flow::review', () => {
  assert.equal(parseFlowStage('flow::triage'), 'triage');
  assert.equal(parseFlowStage('flow::plan'), 'plan');
  assert.equal(parseFlowStage('flow::build'), 'build');
  assert.equal(parseFlowStage('flow::clarify'), 'clarify');
  assert.equal(parseFlowStage('flow::approve'), 'approve');
  assert.equal(parseFlowStage('flow::review'), 'ignored');
  assert.equal(parseFlowStage('flow::ready'), 'unknown');
});

test('deriveIssueMetrics counts gates, automation and durations without review', () => {
  const metrics = deriveIssueMetrics({
    createdAt: Date.parse('2026-06-01T00:00:00Z'),
    labels: ['flow::build', 'type::bug'],
    labelEvents: [
      { labelName: 'flow::triage', action: 'add', createdAt: Date.parse('2026-06-01T00:00:00Z') },
      { labelName: 'flow::plan', action: 'add', createdAt: Date.parse('2026-06-01T01:00:00Z') },
      { labelName: 'flow::review', action: 'add', createdAt: Date.parse('2026-06-01T02:00:00Z') },
      { labelName: 'flow::approve', action: 'add', createdAt: Date.parse('2026-06-01T03:00:00Z') },
      { labelName: 'flow::build', action: 'add', createdAt: Date.parse('2026-06-01T05:00:00Z') },
      { labelName: 'flow::clarify', action: 'add', createdAt: Date.parse('2026-06-01T08:00:00Z') }
    ],
    stateEvents: [
      { state: 'closed', createdAt: Date.parse('2026-06-01T10:00:00Z') },
      { state: 'reopened', createdAt: Date.parse('2026-06-01T11:00:00Z') },
      { state: 'closed', createdAt: Date.parse('2026-06-01T12:00:00Z') }
    ],
    now: Date.parse('2026-06-01T12:00:00Z')
  });

  assert.equal(metrics.issue_flow_gate_count, 2);
  assert.equal(metrics.automation_action_count, 2);
  assert.equal(metrics.reopen_count, 1);
  assert.equal(metrics.is_bug_ever, 1);
  assert.equal(metrics.first_closed_at, Date.parse('2026-06-01T10:00:00Z'));
  assert.equal(metrics.stage_review_sec, undefined);
  assert.equal(metrics.stage_triage_sec, 3600);
  assert.equal(metrics.stage_plan_sec, 7200);
  assert.equal(metrics.stage_approve_sec, 7200);
  assert.equal(metrics.stage_build_sec, 10800);
});
