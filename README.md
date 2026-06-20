# issue-flow

Label-based issue state machine and deterministic GitHub/GitLab issue automation for Agentrix.

## Install

Run this from the project you want to enable:

```bash
curl -fsSL https://raw.githubusercontent.com/nil4u/issue-flow/main/install.sh -o /tmp/issue-flow-install.sh && bash /tmp/issue-flow-install.sh github
```

For GitLab:

```bash
curl -fsSL https://raw.githubusercontent.com/nil4u/issue-flow/main/install.sh -o /tmp/issue-flow-install.sh && bash /tmp/issue-flow-install.sh gitlab
```

Downloading the installer before running it keeps stdin attached to your terminal, so reinstall conflicts can prompt for `skip`, `overwrite`, `skip all`, or `overwrite all`. The `curl | bash` form is fine for one-off non-interactive installs, but it cannot show conflict prompts because stdin is already occupied by the pipe.

Preview without writing files:

```bash
curl -fsSL https://raw.githubusercontent.com/nil4u/issue-flow/main/install.sh -o /tmp/issue-flow-install.sh && bash /tmp/issue-flow-install.sh github --dry-run
```

Overwrite generated files:

```bash
curl -fsSL https://raw.githubusercontent.com/nil4u/issue-flow/main/install.sh -o /tmp/issue-flow-install.sh && bash /tmp/issue-flow-install.sh github --force
```

The installer clones `issue-flow` into a temporary directory, then writes the runtime files into the current project.
After you commit and push the installed files, the installed CI workflow automatically synchronizes the built-in provider labels.
That job creates missing labels and updates label colors/descriptions when they drift. If the workflow token cannot manage repository/project labels, the label sync job fails and the rest of the installed files remain unchanged.

## Create Normalized Issues

After an AI discussion clarifies a self-initiated requirement, the installed skill can create a standardized provider issue through the unified CLI:

```bash
node .agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs issue create \
  --title "Add export support" \
  --body-file /tmp/issue-body.md \
  --type type::feature \
  --status status::active \
  --flow flow::plan \
  --priority priority::p2 \
  --size size::M
```

Use a repo-external temp body file, usually generated from `.issue-flow/templates/type-*.md`. Pass labels only when the discussion makes them clear. Creating or moving an issue directly into `flow::plan` or `flow::build` requires exactly one `size::` label; if the size cannot be judged, use `size::M` and leave a low-confidence note. Use `automation::off` when the issue should be recorded but not picked up by intake or automatic routing.

Size labels also define Weighted Throughput: for completed issues in a time window, sum the weight of each issue's unique `size::` label (`XS=0.5`, `S=1`, `M=2`, `L=3`, `XL=5`). Issues without a size or with conflicting sizes should be excluded from the statistic.

Use `node .agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs --help` to discover issue, PR/MR, label, comment, review, and dispatch commands. Agent-facing provider actions covered by issue-flow should go through this CLI rather than direct `gh`, `glab`, or handwritten provider API calls.

## Reinstall and Upgrade

The installer writes `.issue-flow/install-manifest.json` with the source path, mode, and sha256 for installed files. On reinstall, issue-flow automatically writes new files, updates files that still match the previous manifest, and removes stale files that were installed before and have not been edited.

If an installed file was edited locally, reinstall prompts in an interactive terminal:

```text
skip / overwrite / skip all / overwrite all
```

In non-interactive environments, conflicts fail without changing files. Re-run the installer in a terminal to choose per conflict, or use the existing `--force` flag to overwrite generated files.

## What It Installs

- `.agentrix/plugins/issue-flow/` - plugin manifest, minimal runtime skill, scripts, and default prompts/templates
- `.github/workflows/issue-flow-labels.yml` - automatic provider label synchronization after install or upgrade pushes
- `.github/workflows/issue-flow-auto.yml` - automatic issue routing
- `.github/workflows/issue-flow-comment.yml` - `@agentrix` issue comment routing
- `.github/workflows/issue-flow-pr-review.yml` - optional PR/MR automatic review checks
- `.github/workflows/issue-flow-pr-review-comment.yml` - resumes the PR/MR Agentrix task when a new review comment is added
- `.github/workflows/issue-flow-pr-merged.yml` - plan/build PR merge transitions
- `.github/workflows/issue-flow-failure-intake.yml` - failed workflow analysis and deduped build issue intake
- `.issue-flow/config.json` - issue-flow runtime path config
- `.issue-flow/install-manifest.json` - reinstall tracking metadata
- `.issue-flow/prompts/` - default prompt files you can edit
- `.issue-flow/templates/` - default plan templates you can edit
- `.issue-flow/issues/` - generated issue plan workspace

For GitLab, it writes `.gitlab-ci.yml` and `.gitlab/issue-flow.gitlab-ci.yml` instead of GitHub workflow files. The GitLab include contains an Agentrix daemon webhook bridge `issue-flow-failure-intake` job for failed pipeline events.

## GitHub Configuration

Set these repository variables/secrets as needed:

- `AGENTRIX_BASE_URL` - Agentrix API URL
- `AGENTRIX_API_KEY` - Agentrix API key, as a secret
- `AGENTRIX_RUNNER_ID` - optional runner id
- `AGENTRIX_ISSUE_FLOW_AGENT` - optional agent name, defaults to `codex`
- `ISSUE_FLOW_AUTO_DEFAULT` - optional automation default: `off`, `triage`, `plan`, or `build`
- `ISSUE_FLOW_REVIEW_ENABLED` - optional PR/MR review check switch, defaults to off; set to `true` or `1` to run on PR opened, synchronize, ready_for_review, or manual dispatch

GitHub label sync uses the workflow `GITHUB_TOKEN` with `issues: write`.

Review comment resume is separate from `ISSUE_FLOW_REVIEW_ENABLED`: when an open issue-flow PR/MR body contains `<!-- issue-flow:agentrix:task=<id> -->`, a new GitHub review comment triggers `issue-flow dispatch review-comment`, which resumes that existing Agentrix task with the comment link. The task should reply through `issue-flow pr review-comments reply` and resolve the thread when supported.

GitHub failure intake listens to `workflow_run` completed failures. During the first install, issue-flow scans `.github/workflows/*.yml` and `.github/workflows/*.yaml` and generates the explicit upstream workflow list required by GitHub Actions. Reinstalls preserve the configured list instead of adding newly discovered workflows, so manual exclusions stay intact. To include a new workflow later, edit `.github/workflows/issue-flow-failure-intake.yml` and add it under `workflow_run.workflows`. It uses `GITHUB_TOKEN` with `actions: read` and `issues: write` to inspect failed jobs, classify actionable root causes, and create or update a deduped issue with `failure::ci`, `flow::build`, and `automation::build`.

## GitLab Configuration

GitLab automation is designed for the Agentrix daemon webhook bridge. Configure the GitLab
server in Agentrix, add the daemon webhook URL and secret to the GitLab project, then push the
files generated by `install.sh gitlab`. The installer creates the root `.gitlab-ci.yml` include
for new projects. If `.gitlab-ci.yml` already exists, the installer keeps it by moving that content
to `.gitlab/issue-flow-project.gitlab-ci.yml` and replacing the root file with a wrapper that
includes both the existing pipeline and issue-flow.

Set these CI variables as needed:

- `GITLAB_TOKEN` - GitLab token with issue, merge request, and label management access
- `AGENTRIX_BASE_URL` - Agentrix API URL
- `AGENTRIX_API_KEY` - Agentrix API key, as a masked variable
- `AGENTRIX_RUNNER_ID` - optional runner id
- `AGENTRIX_ISSUE_FLOW_AGENT` - optional agent name, defaults to `codex`
- `ISSUE_FLOW_AUTO_DEFAULT` - optional automation default: `off`, `triage`, `plan`, or `build`
- `ISSUE_FLOW_REVIEW_ENABLED` - optional PR/MR review check switch, defaults to off; set to `true` or `1` to run on PR/MR opened, synchronize, ready_for_review, or manual job

GitLab label sync runs on push in `.gitlab/issue-flow.gitlab-ci.yml` and uses `GITLAB_TOKEN`, `GL_TOKEN`, `GITLAB_PRIVATE_TOKEN`, or `CI_JOB_TOKEN`.

GitLab failure intake is triggered by the Agentrix daemon webhook bridge for failed pipeline events. Agentrix maps GitLab pipeline failures to `workflow_run` / `completed` events with `AGENTRIX_WORKFLOW_RUN_CONCLUSION=failure` or `AGENTRIX_PIPELINE_STATUS=failed`.

GitLab review comment resume is handled by the `issue-flow-review-comment` job for Agentrix bridge `pull_request_review_comment` events and native MR note events. The dispatch command safely skips non-MR notes, closed MRs, missing task markers, and duplicate comment deliveries.

## Development Install

From this repository checkout, run the installer in a target project:

```bash
/path/to/issue-flow/install.sh github --dry-run
```

When `install.sh` is executed from a checkout, it uses that checkout instead of cloning. When it is piped through `curl | bash`, it clones `ISSUE_FLOW_REPO` at `ISSUE_FLOW_REF`.

```bash
ISSUE_FLOW_REPO=https://github.com/nil4u/issue-flow.git ISSUE_FLOW_REF=main \
  curl -fsSL https://raw.githubusercontent.com/nil4u/issue-flow/main/install.sh | bash -s -- github
```
