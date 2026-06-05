# issue-flow

Label-based issue state machine and deterministic GitHub/GitLab issue automation for Agentrix.

## Install

Run this from the project you want to enable:

```bash
curl -fsSL https://raw.githubusercontent.com/nil4u/issue-flow/main/install.sh | bash -s -- github
```

For GitLab:

```bash
curl -fsSL https://raw.githubusercontent.com/nil4u/issue-flow/main/install.sh | bash -s -- gitlab
```

Preview without writing files:

```bash
curl -fsSL https://raw.githubusercontent.com/nil4u/issue-flow/main/install.sh | bash -s -- github --dry-run
```

Overwrite generated files:

```bash
curl -fsSL https://raw.githubusercontent.com/nil4u/issue-flow/main/install.sh | bash -s -- github --force
```

The installer clones `issue-flow` into a temporary directory, then writes the runtime files into the current project.

## What It Installs

- `.agentrix/plugins/issue-flow/` - plugin manifest, minimal runtime skill, scripts, and default prompts/templates
- `.github/workflows/issue-flow-auto.yml` - automatic issue routing
- `.github/workflows/issue-flow-comment.yml` - `@agentrix` issue comment routing
- `.github/workflows/issue-flow-pr-merged.yml` - plan/build PR merge transitions
- `.github/agentrix/issue-flow/config.json` - Agentrix runtime path config

For GitLab, it writes `.gitlab/issue-flow.gitlab-ci.yml` instead of GitHub workflow files.

## GitHub Configuration

Set these repository variables/secrets as needed:

- `AGENTRIX_BASE_URL` - Agentrix API URL
- `AGENTRIX_API_KEY` - Agentrix API key, as a secret
- `AGENTRIX_RUNNER_ID` - optional runner id
- `AGENTRIX_CAPABILITY_PROFILE` - optional capability profile
- `AGENTRIX_ISSUE_FLOW_AGENT` - optional agent name, defaults to `codex`
- `ISSUE_FLOW_AUTO_DEFAULT` - optional automation default: `off`, `triage`, `plan`, or `build`

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
