import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

test('dashboard page keeps Agentrix tasks under issue-first data quality context', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/page.tsx'), 'utf8');
  assert.ok(!page.includes('AgentrixTaskSection'));
  assert.ok(!page.includes('Agentrix task 明细'));
  assert.ok(page.includes('unlinkedAgentrixTaskCount'));
});

test('settings token draft change handler does not close over React event in state updater', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/ProjectSettingsClient.tsx'), 'utf8');
  const tokenDraftInput = source.slice(source.indexOf('placeholder="新 token"') - 220, source.indexOf('placeholder="新 token"') + 120);
  assert.match(tokenDraftInput, /const value = e\.currentTarget\.value/);
  assert.doesNotMatch(tokenDraftInput, /\[project\.id\]: e\.currentTarget\.value/);
});

test('token usage is displayed as tokens instead of USD cost', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/page.tsx'), 'utf8');
  const metrics = readFileSync(join(process.cwd(), 'src/components/MetricsCards.tsx'), 'utf8');
  const table = readFileSync(join(process.cwd(), 'src/components/IssueTableSection.tsx'), 'utf8');

  assert.doesNotMatch(page, /token 成本/);
  assert.ok(metrics.includes('formatTokenCount'));
  assert.ok(metrics.includes('Token 用量'));
  assert.doesNotMatch(metrics, /formatUsd\(/);
  assert.doesNotMatch(metrics, /Token 成本/);

  assert.ok(table.includes('formatTokenCount'));
  assert.ok(table.includes('token_total'));
  assert.ok(table.includes('Token 用量'));
  assert.doesNotMatch(table, /formatUsd\(/);
  assert.doesNotMatch(table, /Token 成本/);
});

test('all pages use the unified redesigned workspace shell', () => {
  const dashboardPage = readFileSync(join(process.cwd(), 'src/app/page.tsx'), 'utf8');
  const settingsPage = readFileSync(join(process.cwd(), 'src/app/settings/page.tsx'), 'utf8');
  const header = readFileSync(join(process.cwd(), 'src/components/DashboardHeader.tsx'), 'utf8');
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
  const pkg = readFileSync(join(process.cwd(), 'package.json'), 'utf8');

  assert.ok(pkg.includes('lucide-react'));
  assert.ok(header.includes('lucide-react'));
  assert.ok(dashboardPage.includes('app-shell'));
  assert.ok(settingsPage.includes('app-shell'));
  assert.ok(settingsPage.includes('settings-hero'));
  assert.ok(css.includes('--accent'));
  assert.ok(css.includes('.app-shell'));
  assert.ok(css.includes('.workspace-header'));
  assert.ok(css.includes('.custom-check'));
  assert.ok(css.includes('@media (max-width: 760px)'));
});

test('dashboard redirects to settings when no GitLab project is configured', () => {
  const dashboardPage = readFileSync(join(process.cwd(), 'src/app/page.tsx'), 'utf8');
  const settingsPage = readFileSync(join(process.cwd(), 'src/app/settings/page.tsx'), 'utf8');
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

  assert.ok(dashboardPage.includes("import { redirect } from 'next/navigation'"));
  assert.ok(dashboardPage.includes('readConfiguredProjects(db).length === 0'));
  assert.ok(dashboardPage.includes("redirect('/settings?setup=missing_gitlab_project')"));

  assert.ok(settingsPage.includes('setup=missing_gitlab_project'));
  assert.ok(settingsPage.includes('请先配置至少一个 GitLab 项目'));
  assert.ok(settingsPage.includes('setup-alert'));
  assert.ok(css.includes('.setup-alert'));
});

test('human intervention and phase duration rows show short metric explanations', () => {
  const human = readFileSync(join(process.cwd(), 'src/components/HumanInterventionSection.tsx'), 'utf8');
  const phase = readFileSync(join(process.cwd(), 'src/components/PhaseDurationSection.tsx'), 'utf8');
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

  assert.ok(human.includes('metric-row-copy'));
  assert.ok(human.includes('Clarify / Approve 标签次数'));
  assert.ok(human.includes('人工输入次数'));
  assert.ok(human.includes('人工回复次数'));
  assert.doesNotMatch(human, /第一版不纳入权限确认/);

  assert.ok(phase.includes('metric-row-copy'));
  assert.ok(phase.includes('Triage + Clarify'));
  assert.ok(phase.includes('Plan + Approve'));
  assert.ok(phase.includes('Build 阶段'));
  assert.doesNotMatch(phase, /阶段时长表示等待/);

  assert.ok(css.includes('.metric-row-copy'));
});
