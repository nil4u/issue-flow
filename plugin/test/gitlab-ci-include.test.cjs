const assert = require('node:assert/strict');
const test = require('node:test');

const {
  addLocalInclude,
  hasLocalInclude,
} = require('../skills/issue-flow/scripts/gitlab-ci-include.cjs');

const target = '.gitlab/issue-flow.gitlab-ci.yml';

test('missing include inserts local include block at top', () => {
  const input = 'stages:\n  - test\n';
  assert.equal(addLocalInclude(input, target).content, [
    'include:',
    `  - local: ${target}`,
    '',
    'stages:',
    '  - test',
    '',
  ].join('\n'));
});

test('include list appends local include', () => {
  const input = 'include:\n  - local: ci/base.yml\n\njob:\n  script: echo ok\n';
  assert.equal(addLocalInclude(input, target).content, 'include:\n  - local: ci/base.yml\n  - local: .gitlab/issue-flow.gitlab-ci.yml\n\njob:\n  script: echo ok\n');
});

test('include scalar becomes list', () => {
  const input = 'include: ci/base.yml\njob:\n  script: echo ok\n';
  assert.equal(addLocalInclude(input, target).content, 'include:\n  - ci/base.yml\n  - local: .gitlab/issue-flow.gitlab-ci.yml\njob:\n  script: echo ok\n');
});

test('include map becomes list', () => {
  const input = 'include:\n  project: group/shared\n  file: ci.yml\njob:\n  script: echo ok\n';
  assert.equal(addLocalInclude(input, target).content, 'include:\n  - project: group/shared\n    file: ci.yml\n  - local: .gitlab/issue-flow.gitlab-ci.yml\njob:\n  script: echo ok\n');
});

test('existing local include is unchanged', () => {
  const input = 'include:\n  - local: .gitlab/issue-flow.gitlab-ci.yml\n';
  const result = addLocalInclude(input, target);
  assert.equal(hasLocalInclude(input, target), true);
  assert.equal(result.changed, false);
  assert.equal(result.content, input);
});

test('existing local include accepts GitLab leading slash spelling', () => {
  const input = 'include:\n  - local: /.gitlab/issue-flow.gitlab-ci.yml\n';
  const result = addLocalInclude(input, target);
  assert.equal(hasLocalInclude(input, target), true);
  assert.equal(result.changed, false);
  assert.equal(result.content, input);
});

test('commented and non-include paths do not count as configured', () => {
  assert.equal(hasLocalInclude('# - local: .gitlab/issue-flow.gitlab-ci.yml\n', target), false);
  assert.equal(hasLocalInclude('job:\n  artifacts:\n    paths:\n      - .gitlab/issue-flow.gitlab-ci.yml\n', target), false);
});

test('zero-indent include list appends local include', () => {
  const input = 'include:\n- local: ci/base.yml\njob:\n  script: echo ok\n';
  assert.equal(
    addLocalInclude(input, target).content,
    'include:\n- local: ci/base.yml\n- local: .gitlab/issue-flow.gitlab-ci.yml\njob:\n  script: echo ok\n'
  );
});

test('comments and non-include content are preserved', () => {
  const input = '# header\ninclude:\n  - local: ci/base.yml # keep\n\njob:\n  script: echo ok\n';
  const result = addLocalInclude(input, target).content;
  assert.equal(result, '# header\ninclude:\n  - local: ci/base.yml # keep\n  - local: .gitlab/issue-flow.gitlab-ci.yml\n\njob:\n  script: echo ok\n');
});

test('complex include returns needsReview', () => {
  const input = 'include:\n  rules:\n    - if: $CI_COMMIT_BRANCH\n      local: ci/base.yml\n';
  const result = addLocalInclude(input, target);
  assert.equal(result.needsReview, true);
  assert.equal(result.content, input);
});

test('inline flow include returns needsReview', () => {
  for (const input of [
    'include: [ci/a.yml, ci/b.yml]\n',
    'include: {local: ci/base.yml}\n',
    'include: !reference [.shared, include]\n',
  ]) {
    const result = addLocalInclude(input, target);
    assert.equal(result.needsReview, true, input);
    assert.equal(result.content, input);
  }
});

test('map include with interior comment returns needsReview', () => {
  const input = 'include:\n  # shared pipeline\n  project: group/shared\n  file: ci.yml\n';
  const result = addLocalInclude(input, target);
  assert.equal(result.needsReview, true);
  assert.equal(result.content, input);
});

test('map include followed by blank line still converts', () => {
  const input = 'include:\n  project: group/shared\n  file: ci.yml\n\njob:\n  script: echo ok\n';
  assert.equal(
    addLocalInclude(input, target).content,
    'include:\n  - project: group/shared\n    file: ci.yml\n  - local: .gitlab/issue-flow.gitlab-ci.yml\n\njob:\n  script: echo ok\n'
  );
});

test('document markers return needsReview', () => {
  const input = '---\ninclude:\n  - local: ci/base.yml\n';
  const result = addLocalInclude(input, target);
  assert.equal(result.needsReview, true);
  assert.equal(result.content, input);
});

test('trailing top-level comment stays below the appended include', () => {
  const input = 'include:\n  - local: ci/base.yml\n# jobs below\njob:\n  script: echo ok\n';
  assert.equal(
    addLocalInclude(input, target).content,
    'include:\n  - local: ci/base.yml\n  - local: .gitlab/issue-flow.gitlab-ci.yml\n# jobs below\njob:\n  script: echo ok\n'
  );
});
