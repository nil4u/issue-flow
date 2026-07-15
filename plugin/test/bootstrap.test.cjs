const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AGENTRIX_PLUGIN_SPECS,
  AGENTRIX_PROJECT_DIRS,
  AGENTRIX_PROJECT_FILES,
  LEGACY_AGENTRIX_PROJECT_ROOT,
  installGithub,
  installGitlab,
  parseArgs,
  createInstallPlan,
  runBootstrap,
} = require('../skills/issue-flow/scripts/bootstrap.cjs');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-bootstrap-test-'));
}

test('bootstrap parser accepts runtime, force, and dry-run behavior options', () => {
  assert.deepEqual(parseArgs(['github', '--runtime', 'agentrix', '--force', '--dry-run']), {
    target: 'github',
    options: {
      _: [],
      runtime: 'agentrix',
      force: true,
      dryRun: true,
    },
  });
});

test('bootstrap parser accepts top-level help', () => {
  assert.deepEqual(parseArgs(['--help']), {
    target: undefined,
    options: {
      _: [],
      help: true,
    },
  });
});

test('bootstrap rejects workflow and plugin directory overrides', () => {
  assert.throws(
    () => parseArgs(['github', '--workflow-dir', '.github/workflows/custom']),
    /Unknown option: --workflow-dir/
  );
  assert.throws(
    () => parseArgs(['github', '--plugin-dir', '.agentrix/plugins/custom']),
    /Unknown option: --plugin-dir/
  );
});

test('github bootstrap writes workflow and Agentrix config convention paths', () => {
  const root = makeTempRoot();
  try {
    const results = installGithub({ cwd: root });
    const written = results.map((result) => path.relative(root, result.target)).sort();
    assert.deepEqual(written, [
      ...AGENTRIX_PLUGIN_SPECS.map(([, target]) => target),
      ...AGENTRIX_PROJECT_FILES.map(([, target]) => target),
      ...AGENTRIX_PROJECT_DIRS.map(([, target]) => target),
      '.github/workflows/issue-flow-labels.yml',
      '.github/workflows/issue-flow-auto.yml',
      '.github/workflows/issue-flow-comment.yml',
      '.github/workflows/issue-flow-pr-merged.yml',
      '.github/workflows/issue-flow-pr-review-comment.yml',
      '.github/workflows/issue-flow-pr-review.yml',
      '.issue-flow/install-manifest.json',
    ].sort());
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/issue-flow-labels.yml')), true);
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/issue-flow-auto.yml')), true);
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/issue-flow-failure-intake.yml')), false);
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/issue-flow-pr-review.yml')), true);
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/issue-flow-pr-review-comment.yml')), true);
    const labelsWorkflow = fs.readFileSync(path.join(root, '.github/workflows/issue-flow-labels.yml'), 'utf8');
    const autoWorkflow = fs.readFileSync(path.join(root, '.github/workflows/issue-flow-auto.yml'), 'utf8');
    const reviewWorkflow = fs.readFileSync(path.join(root, '.github/workflows/issue-flow-pr-review.yml'), 'utf8');
    const reviewCommentWorkflow = fs.readFileSync(path.join(root, '.github/workflows/issue-flow-pr-review-comment.yml'), 'utf8');
    assert.match(labelsWorkflow, /Issue Flow Labels/);
    assert.match(labelsWorkflow, /issues: write/);
    assert.match(labelsWorkflow, /sync-labels\.cjs --provider github/);
    assert.match(labelsWorkflow, /github\.repository/);
    assert.match(autoWorkflow, /- opened/);
    assert.match(autoWorkflow, /- labeled/);
    assert.match(autoWorkflow, /github\.event\.action != 'labeled'/);
    assert.match(autoWorkflow, /startsWith\(github\.event\.label\.name, 'flow::'\)/);
    assert.match(autoWorkflow, /github\.event\.label\.name == 'automation::build'/);
    assert.match(autoWorkflow, /github\.event\.label\.name == 'status::active'/);
    assert.match(autoWorkflow, /queue: max/);
    assert.doesNotMatch(autoWorkflow, /- edited/);
    assert.doesNotMatch(autoWorkflow, /- reopened/);
    assert.match(reviewWorkflow, /Issue Flow PR Review/);
    assert.match(reviewWorkflow, /ready_for_review/);
    assert.match(reviewWorkflow, /pull-requests: write/);
    assert.match(reviewWorkflow, /ref: \$\{\{ github\.event\.pull_request\.base\.ref \|\| github\.event\.repository\.default_branch \}\}/);
    assert.match(reviewWorkflow, /ISSUE_FLOW_REVIEW_ENABLED == 'true'/);
    assert.match(reviewWorkflow, /ISSUE_FLOW_REVIEW_ENABLED == '1'/);
    assert.match(reviewWorkflow, /dispatch\.cjs review --pr-number/);
    assert.match(reviewCommentWorkflow, /Issue Flow PR Review Comment/);
    assert.match(reviewCommentWorkflow, /pull_request_review_comment:/);
    assert.match(reviewCommentWorkflow, /- created/);
    assert.match(reviewCommentWorkflow, /pull-requests: write/);
    assert.match(reviewCommentWorkflow, /contains\(github\.event\.pull_request\.body, 'source_task_id='\)/);
    assert.match(reviewCommentWorkflow, /contains\(github\.event\.pull_request\.body, 'source_runtime=agentrix'\)/);
    assert.match(reviewCommentWorkflow, /github\.event\.comment\.pull_request_review_id \|\| github\.event\.comment\.id/);
    assert.match(reviewCommentWorkflow, /cli\.cjs dispatch review-comment/);
    assert.doesNotMatch(reviewCommentWorkflow, /ISSUE_FLOW_REVIEW_ENABLED/);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/config.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/install-manifest.json')), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.issue-flow/install-manifest.json'), 'utf8'));
    assert.equal(manifest.version, 1);
	    assert.equal(manifest.files['.github/workflows/issue-flow-auto.yml'].mode, 'managed');
	    assert.equal(manifest.files['.issue-flow/prompts/build-ci-failure.prompt.md'].mode, 'customizable');
	    assert.equal(
	      manifest.files['.issue-flow/prompts/build-ci-failure.prompt.md'].source,
	      'skills/issue-flow/assets/agentrix/runtime/prompts/build-ci-failure.prompt.md'
	    );
	    assert.equal(manifest.files['.issue-flow/templates/plan-impl.md'].mode, 'customizable');
    assert.equal(
      manifest.files['.issue-flow/templates/plan-impl.md'].source,
      'skills/issue-flow/assets/agentrix/runtime/templates/plan-impl.md'
    );
    assert.match(manifest.files['.issue-flow/templates/plan-impl.md'].sha256, /^[a-f0-9]{64}$/);
	    assert.equal(fs.existsSync(path.join(root, '.issue-flow/issues/README.md')), true);
	    assert.equal(fs.existsSync(path.join(root, '.issue-flow/prompts/build-ci-failure.prompt.md')), true);
	    assert.equal(fs.existsSync(path.join(root, '.issue-flow/prompts/build.prompt.md')), true);
	    assert.equal(fs.existsSync(path.join(root, '.issue-flow/prompts/plan-visual-impl.prompt.md')), true);
	    assert.equal(fs.existsSync(path.join(root, '.issue-flow/prompts/plan-visual-bug.prompt.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/prompts/review.prompt.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/templates/plan-impl.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/.claude-plugin/plugin.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/dispatch.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/create-issue.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/sync-labels.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/vision-plan/SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/vision-plan/plan-kit/check.mjs')), true);
	    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/assets/agentrix/runtime/prompts/build-ci-failure.prompt.md')), true);
	    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/assets/agentrix/runtime/prompts/build.prompt.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/package.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/CLAUDE.md')), false);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/bootstrap.cjs')), false);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/assets/agentrix/bootstrap/workflows/github/issue-flow-auto.yml')), false);
    assert.doesNotMatch(autoWorkflow, /\.github\/agentrix/);
    const mergedWorkflow = fs.readFileSync(path.join(root, '.github/workflows/issue-flow-pr-merged.yml'), 'utf8');
    assert.match(mergedWorkflow, /ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap updates legacy managed files and force overwrites conflicts', () => {
  const root = makeTempRoot();
  try {
    const workflowPath = path.join(root, '.github/workflows/issue-flow-auto.yml');
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, 'custom');

    const updated = installGithub({ cwd: root }).find((result) => result.target === workflowPath);
    assert.equal(updated.action, 'updated');
    assert.match(fs.readFileSync(workflowPath, 'utf8'), /Issue Flow Auto/);

    fs.writeFileSync(workflowPath, 'custom again');
    assert.throws(
      () => installGithub({ cwd: root }),
      /Install conflicts require an interactive terminal\.[\s\S]*\.github\/workflows\/issue-flow-auto\.yml/
    );
    assert.equal(fs.readFileSync(workflowPath, 'utf8'), 'custom again');

    const overwritten = installGithub({ cwd: root, force: true }).find((result) => result.target === workflowPath);
    assert.equal(overwritten.action, 'written');
    assert.match(fs.readFileSync(workflowPath, 'utf8'), /Issue Flow Auto/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap keeps tracked customizable file when upstream is unchanged', () => {
  const root = makeTempRoot();
  try {
    installGithub({ cwd: root });
    const templatePath = path.join(root, '.issue-flow/templates/plan-impl.md');
    fs.writeFileSync(templatePath, 'custom plan template');

    const plan = createInstallPlan('github', { cwd: root });
    assert.equal(plan.conflicts.some((conflict) => conflict.path === '.issue-flow/templates/plan-impl.md'), false);
    installGithub({ cwd: root });
    assert.equal(fs.readFileSync(templatePath, 'utf8'), 'custom plan template');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap reports three-way conflict when customizable file and upstream both changed', () => {
  const root = makeTempRoot();
  try {
    installGithub({ cwd: root });
    const templatePath = path.join(root, '.issue-flow/templates/plan-impl.md');
    fs.writeFileSync(templatePath, 'custom plan template');

    const manifestPath = path.join(root, '.issue-flow/install-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files['.issue-flow/templates/plan-impl.md'].sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const plan = createInstallPlan('github', { cwd: root });
    const conflict = plan.conflicts.find((item) => item.path === '.issue-flow/templates/plan-impl.md');
    assert.equal(conflict.category, 'user_customizations');
    assert.equal(conflict.kind, 'desired');
    assert.equal(conflict.reason, 'modified');
    assert.equal(conflict.defaultAction, 'keep');
    assert.deepEqual(conflict.allowedActions, ['overwrite', 'keep']);
    assert.equal(conflict.currentContent, undefined);
    assert.equal(conflict.proposedContent, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap keep decision acknowledges upstream without writing the file', () => {
  const root = makeTempRoot();
  try {
    installGithub({ cwd: root });
    const templatePath = path.join(root, '.issue-flow/templates/plan-impl.md');
    fs.writeFileSync(templatePath, 'custom plan template');

    const manifestPath = path.join(root, '.issue-flow/install-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files['.issue-flow/templates/plan-impl.md'].sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const results = runBootstrap('github', {
      cwd: root,
      decisions: { actions: { '.issue-flow/templates/plan-impl.md': 'keep' } },
    });
    const kept = results.find((result) => result.target === templatePath);
    assert.equal(kept.action, 'skipped');
    assert.equal(kept.reason, 'keep');
    assert.equal(fs.readFileSync(templatePath, 'utf8'), 'custom plan template');

    const upstreamSha = require('node:crypto').createHash('sha256')
      .update(fs.readFileSync(path.resolve(__dirname, '../skills/issue-flow/assets/agentrix/runtime/templates/plan-impl.md')))
      .digest('hex');
    const nextManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(nextManifest.files['.issue-flow/templates/plan-impl.md'].sha256, upstreamSha);

    const plan = createInstallPlan('github', { cwd: root });
    assert.equal(plan.conflicts.some((item) => item.path === '.issue-flow/templates/plan-impl.md'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap reports managed conflict with overwrite default and applies overwrite decision', () => {
  const root = makeTempRoot();
  try {
    installGithub({ cwd: root });
    const workflowPath = path.join(root, '.github/workflows/issue-flow-auto.yml');
    fs.writeFileSync(workflowPath, 'custom workflow');

    const plan = createInstallPlan('github', { cwd: root });
    const conflict = plan.conflicts.find((item) => item.path === '.github/workflows/issue-flow-auto.yml');
    assert.equal(conflict.category, 'managed');
    assert.equal(conflict.reason, 'modified');
    assert.equal(conflict.defaultAction, 'overwrite');
    assert.deepEqual(conflict.allowedActions, ['overwrite', 'keep']);

    runBootstrap('github', {
      cwd: root,
      decisions: { actions: { '.github/workflows/issue-flow-auto.yml': 'overwrite' } },
    });
    assert.match(fs.readFileSync(workflowPath, 'utf8'), /Issue Flow Auto/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap forget decision keeps modified stale customizable file on disk', () => {
  const root = makeTempRoot();
  try {
    installGithub({ cwd: root });
    const stalePath = path.join(root, '.issue-flow/prompts/legacy.prompt.md');
    fs.writeFileSync(stalePath, 'user modified stale prompt');

    const manifestPath = path.join(root, '.issue-flow/install-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files['.issue-flow/prompts/legacy.prompt.md'] = {
      source: 'old/legacy.prompt.md',
      mode: 'customizable',
      sha256: '0'.repeat(64),
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const plan = createInstallPlan('github', { cwd: root });
    const conflict = plan.conflicts.find((item) => item.path === '.issue-flow/prompts/legacy.prompt.md');
    assert.equal(conflict.category, 'stale');
    assert.equal(conflict.kind, 'stale');
    assert.equal(conflict.reason, 'stale-modified');
    assert.equal(conflict.defaultAction, 'forget');
    assert.deepEqual(conflict.allowedActions, ['remove', 'forget']);

    const results = runBootstrap('github', {
      cwd: root,
      decisions: { actions: { '.issue-flow/prompts/legacy.prompt.md': 'forget' } },
    });
    const forgotten = results.find((result) => result.target === stalePath);
    assert.equal(forgotten.action, 'skipped');
    assert.equal(forgotten.reason, 'forget');
    assert.equal(fs.readFileSync(stalePath, 'utf8'), 'user modified stale prompt');
    const nextManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(nextManifest.files['.issue-flow/prompts/legacy.prompt.md'], undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap removes unmodified stale files tracked by the manifest', () => {
  const root = makeTempRoot();
  try {
    installGithub({ cwd: root });
    const stalePath = path.join(root, '.agentrix/plugins/issue-flow/stale.txt');
    fs.writeFileSync(stalePath, 'old generated file');

    const manifestPath = path.join(root, '.issue-flow/install-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files['.agentrix/plugins/issue-flow/stale.txt'] = {
      source: 'old/stale.txt',
      mode: 'managed',
      sha256: require('node:crypto').createHash('sha256').update('old generated file').digest('hex'),
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const removed = installGithub({ cwd: root }).find((result) => result.target === stalePath);
    assert.equal(removed.action, 'removed');
    assert.equal(fs.existsSync(stalePath), false);
    const nextManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(nextManifest.files['.agentrix/plugins/issue-flow/stale.txt'], undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap force removes stale plugin files when installing from source', () => {
  const root = makeTempRoot();
  try {
    const stalePackage = path.join(root, '.agentrix/plugins/issue-flow/package.json');
    fs.mkdirSync(path.dirname(stalePackage), { recursive: true });
    fs.writeFileSync(stalePackage, '{}');

    installGithub({ cwd: root, force: true });
    assert.equal(fs.existsSync(stalePackage), false);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/.claude-plugin/plugin.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/dispatch.cjs')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap force removes legacy Agentrix project config root', () => {
  const root = makeTempRoot();
  try {
    const legacyConfig = path.join(root, LEGACY_AGENTRIX_PROJECT_ROOT, 'config.json');
    fs.mkdirSync(path.dirname(legacyConfig), { recursive: true });
    fs.writeFileSync(legacyConfig, '{}');

    const results = installGitlab({ cwd: root, force: true });
    const removed = results.find((result) => path.relative(root, result.target) === LEGACY_AGENTRIX_PROJECT_ROOT);
    assert.equal(removed.action, 'removed');
    assert.equal(fs.existsSync(path.join(root, LEGACY_AGENTRIX_PROJECT_ROOT)), false);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/config.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitlab bootstrap writes include snippet and Agentrix config convention paths', () => {
  const root = makeTempRoot();
  try {
    const results = runBootstrap('gitlab', {
      cwd: root,
      decisions: { actions: { '.gitlab-ci.yml': 'use_proposed' } },
    });
    const written = results.map((result) => path.relative(root, result.target)).sort();
    assert.deepEqual(written, [
      ...AGENTRIX_PLUGIN_SPECS.map(([, target]) => target),
      ...AGENTRIX_PROJECT_FILES.map(([, target]) => target),
      ...AGENTRIX_PROJECT_DIRS.map(([, target]) => target),
      '.gitlab-ci.yml',
      '.gitlab/issue-flow.gitlab-ci.yml',
      '.issue-flow/install-manifest.json',
    ].sort());
    assert.match(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'), /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/);
    const gitlabWorkflow = fs.readFileSync(path.join(root, '.gitlab/issue-flow.gitlab-ci.yml'), 'utf8');
    assert.match(gitlabWorkflow, /\.issue-flow-runner:\n  tags:\n    - issue-flow/);
    for (const job of [
      'issue-flow-labels',
      'issue-flow-auto',
      'issue-flow-comment',
      'issue-flow-merged',
      'issue-flow-review',
      'issue-flow-review-comment',
    ]) {
      assert.match(gitlabWorkflow, new RegExp(`${job}:\\n  extends: \\.issue-flow-runner\\n  stage: build`));
    }
    assert.match(gitlabWorkflow, /CI_PIPELINE_SOURCE == "push"/);
    assert.match(gitlabWorkflow, /sync-labels\.cjs "\$@"/);
    assert.match(gitlabWorkflow, /GITLAB_BRIDGE_EVENT_NAME == "issues"/);
    assert.match(gitlabWorkflow, /GITLAB_BRIDGE_LABELS_JSON =~ \/failure::ci\//);
    assert.match(gitlabWorkflow, /GITLAB_BRIDGE_ISSUE_TITLE =~ \/\^Fix CI failure:\//);
    assert.match(gitlabWorkflow, /AGENTRIX_TRIGGER_SOURCE == "agentrix_daemon_webhook"/);
    assert.ok(
      gitlabWorkflow.indexOf('GITLAB_BRIDGE_LABELS_JSON =~ /failure::ci/') <
        gitlabWorkflow.indexOf('GITLAB_BRIDGE_EVENT_ACTION == "opened"'),
      'GitLab failure::ci skip rule should run before issue opened auto routing'
    );
    assert.match(gitlabWorkflow, /GITLAB_BRIDGE_EVENT_NAME == "pull_request"/);
    assert.match(gitlabWorkflow, /bridge_event_action="\$\{GITLAB_BRIDGE_EVENT_ACTION:-\$\{AGENTRIX_EVENT_ACTION:-\}\}"/);
    assert.match(gitlabWorkflow, /intake\.cjs --issue-number "\$bridge_issue_number"/);
    assert.match(gitlabWorkflow, /dispatch\.cjs auto/);
    assert.match(gitlabWorkflow, /issue-flow-review:/);
    assert.match(gitlabWorkflow, /ISSUE_FLOW_REVIEW_ENABLED =~ \/\^\(true\|1\)\$\//);
    assert.match(gitlabWorkflow, /GITLAB_BRIDGE_EVENT_ACTION == "ready_for_review"/);
    assert.match(gitlabWorkflow, /git fetch origin "\$\{CI_DEFAULT_BRANCH:-main\}" --depth 1/);
    assert.match(gitlabWorkflow, /git checkout FETCH_HEAD -- \.agentrix\/plugins\/issue-flow \.issue-flow/);
    assert.match(gitlabWorkflow, /--pr-number "\$bridge_pr_number"/);
    assert.match(gitlabWorkflow, /dispatch\.cjs review/);
    assert.match(gitlabWorkflow, /issue-flow-review-comment:/);
    assert.match(gitlabWorkflow, /GITLAB_BRIDGE_EVENT_NAME == "pull_request_review_comment"/);
    assert.match(gitlabWorkflow, /GITLAB_BRIDGE_EVENT_NAME == "issue_comment" && \$GITLAB_BRIDGE_PR_NUMBER/);
    assert.match(gitlabWorkflow, /GITLAB_EVENT_NAME == "note"/);
    assert.match(gitlabWorkflow, /cli\.cjs dispatch review-comment/);
    assert.doesNotMatch(gitlabWorkflow, /issue-flow-failure-intake:/);
    assert.doesNotMatch(gitlabWorkflow, /dispatch pipeline-failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitlab bootstrap appends include to existing root ci without discarding it', () => {
  const root = makeTempRoot();
  try {
    const rootCi = path.join(root, '.gitlab-ci.yml');
    fs.writeFileSync(rootCi, 'stages:\n  - test\n\nunit:\n  script: echo ok\n');

    const results = runBootstrap('gitlab', {
      cwd: root,
      decisions: { actions: { '.gitlab-ci.yml': 'use_proposed' } },
    });
    const updated = results.find((result) => result.target === rootCi);
    assert.equal(updated.action, 'updated');
    assert.match(fs.readFileSync(rootCi, 'utf8'), /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/);
    assert.match(fs.readFileSync(rootCi, 'utf8'), /stages:\n  - test\n\nunit:\n  script: echo ok/);
    assert.equal(fs.existsSync(path.join(root, '.gitlab/issue-flow-project.gitlab-ci.yml')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitlab bootstrap plan reports root ci include conflict', () => {
  const root = makeTempRoot();
  try {
    const rootCi = path.join(root, '.gitlab-ci.yml');
    fs.writeFileSync(rootCi, 'stages:\n  - test\n');

    const plan = createInstallPlan('gitlab', { cwd: root });
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].id, '.gitlab-ci.yml');
    assert.equal(plan.conflicts[0].category, 'gitlab_ci');
    assert.equal(plan.conflicts[0].defaultAction, 'use_proposed');
    assert.match(plan.conflicts[0].proposedContent, /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/);
    assert.equal(fs.readFileSync(rootCi, 'utf8'), 'stages:\n  - test\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitlab bootstrap plan reports complex root ci include for manual review', () => {
  const root = makeTempRoot();
  try {
    const rootCi = path.join(root, '.gitlab-ci.yml');
    const complexCi = 'include:\n  rules:\n    - if: $CI_COMMIT_BRANCH\n      local: ci/base.yml\n';
    fs.writeFileSync(rootCi, complexCi);

    const plan = createInstallPlan('gitlab', { cwd: root });
    const conflict = plan.conflicts.find((item) => item.id === '.gitlab-ci.yml');
    assert.equal(conflict.reason, 'complex_include');
    assert.equal(conflict.defaultAction, 'keep_current');
    assert.deepEqual(conflict.allowedActions, ['keep_current']);
    assert.equal(conflict.proposedContent, undefined);
    assert.match(conflict.message, /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/);

    const results = runBootstrap('gitlab', {
      cwd: root,
      decisions: { actions: { '.gitlab-ci.yml': 'keep_current' } },
    });
    const skipped = results.find((result) => result.target === rootCi);
    assert.equal(skipped.action, 'skipped');
    assert.equal(skipped.reason, 'keep_current');
    assert.match(skipped.message, /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/);
    assert.equal(fs.readFileSync(rootCi, 'utf8'), complexCi);

    const nextPlan = createInstallPlan('gitlab', { cwd: root });
    assert.equal(nextPlan.conflicts.some((item) => item.id === '.gitlab-ci.yml'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitlab bootstrap re-install keeps root ci with include and user jobs', () => {
  const root = makeTempRoot();
  try {
    const rootCi = path.join(root, '.gitlab-ci.yml');
    fs.writeFileSync(rootCi, 'stages:\n  - test\n\nunit:\n  script: echo ok\n');
    runBootstrap('gitlab', {
      cwd: root,
      decisions: { actions: { '.gitlab-ci.yml': 'use_proposed' } },
    });
    const installed = fs.readFileSync(rootCi, 'utf8');

    const plan = createInstallPlan('gitlab', { cwd: root });
    assert.equal(plan.conflicts.length, 0);

    const results = runBootstrap('gitlab', { cwd: root });
    const rootCiResults = results.filter((result) => result.target === rootCi);
    assert.deepEqual(rootCiResults.map((result) => result.action), ['skipped']);
    assert.equal(fs.readFileSync(rootCi, 'utf8'), installed);
    assert.match(installed, /unit:\n  script: echo ok/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitlab bootstrap keep_current decision on simple include persists across installs', () => {
  const root = makeTempRoot();
  try {
    const rootCi = path.join(root, '.gitlab-ci.yml');
    const original = 'stages:\n  - test\n\nunit:\n  script: echo ok\n';
    fs.writeFileSync(rootCi, original);
    runBootstrap('gitlab', {
      cwd: root,
      decisions: { actions: { '.gitlab-ci.yml': 'keep_current' } },
    });
    assert.equal(fs.readFileSync(rootCi, 'utf8'), original);

    const plan = createInstallPlan('gitlab', { cwd: root });
    assert.equal(plan.conflicts.some((item) => item.id === '.gitlab-ci.yml'), false);

    const results = runBootstrap('gitlab', { cwd: root });
    const rootCiResults = results.filter((result) => result.target === rootCi);
    assert.deepEqual(rootCiResults.map((result) => result.action), ['skipped']);
    assert.equal(fs.readFileSync(rootCi, 'utf8'), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap managed keep decision persists across an intermediate install', () => {
  const root = makeTempRoot();
  try {
    installGithub({ cwd: root });
    const workflowPath = path.join(root, '.github/workflows/issue-flow-auto.yml');
    fs.writeFileSync(workflowPath, 'custom workflow');
    runBootstrap('github', {
      cwd: root,
      decisions: { actions: { '.github/workflows/issue-flow-auto.yml': 'keep' } },
    });

    installGithub({ cwd: root });
    assert.equal(fs.readFileSync(workflowPath, 'utf8'), 'custom workflow');

    const plan = createInstallPlan('github', { cwd: root });
    assert.equal(plan.conflicts.some((item) => item.path === '.github/workflows/issue-flow-auto.yml'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitlab bootstrap leaves already configured root ci alone', () => {
  const root = makeTempRoot();
  try {
    const rootCi = path.join(root, '.gitlab-ci.yml');
    fs.writeFileSync(rootCi, 'include:\n  - local: .gitlab/issue-flow.gitlab-ci.yml\n');

    const results = installGitlab({ cwd: root });
    const skipped = results.find((result) => result.target === rootCi);
    assert.equal(skipped.action, 'skipped');
    assert.equal(skipped.reason, 'configured');
    assert.equal(fs.existsSync(path.join(root, '.gitlab/issue-flow-project.gitlab-ci.yml')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap rejects unsupported runtimes', () => {
  assert.throws(
    () => runBootstrap('github', { runtime: 'other' }),
    /Unsupported bootstrap runtime/
  );
});
