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

## Release Management

`main` is the release branch. Pushes to `main` run Release Please, which opens or updates a release PR from Conventional Commit history.

The release PR updates:

- `package.json`
- `skills/issue-flow/SKILL.md`
- `.release-please-manifest.json`
- `CHANGELOG.md`

Merge the release PR to create the GitHub release and `vX.Y.Z` tag. The release workflow does not publish to npm.

Write merge commits and direct commits with Conventional Commit prefixes:

- `fix:` creates a patch release.
- `feat:` creates a minor release.
- `feat!:` or a `BREAKING CHANGE:` footer creates a major release.

Pinned installs can use a tag:

```bash
ISSUE_FLOW_REF=v0.1.1 \
  curl -fsSL https://raw.githubusercontent.com/nil4u/issue-flow/main/install.sh | bash -s -- github
```

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

## Prompt Principles

Treat the agent like a person. A prompt should be minimal and complete: give the agent the goal, the hard constraints, and the expected output, then let it inspect the issue, comments, PR/MR, and repository context itself.

- Do not duplicate context the runtime already provides, such as issue bodies, comment text, task ids, URLs, labels, or event metadata.
- Put durable workflow rules in the action prompts and skill docs; keep event-specific resume prompts short.
- Resume prompts should only state the new signal and the expected continuation. For example, "Issue has a new comment; review it and continue."
- Add detail only when it changes the agent's decision boundary. If a sentence merely restates available context, remove it.

## GitHub Configuration

Set these repository variables/secrets as needed:

- `AGENTRIX_BASE_URL` - Agentrix API URL
- `AGENTRIX_API_KEY` - Agentrix API key, as a secret
- `AGENTRIX_RUNNER_ID` - optional runner id
- `AGENTRIX_ISSUE_FLOW_AGENT` - optional agent name, defaults to `codex`
- `ISSUE_FLOW_AUTO_DEFAULT` - optional automation default: `off`, `triage`, `plan`, or `build`
- `ISSUE_FLOW_REVIEW_ENABLED` - optional PR/MR review check switch, defaults to off; set to `true` or `1` to run on PR opened, synchronize, ready_for_review, or manual dispatch

GitHub label sync uses the workflow `GITHUB_TOKEN` with `issues: write`. Provider tokens are only for issue-flow routing jobs; when issue-flow starts or resumes an Agentrix task, it does not forward `GITHUB_TOKEN`/`GH_TOKEN` into the Agentrix task environment.

Review comment resume is separate from `ISSUE_FLOW_REVIEW_ENABLED`: when an open issue-flow PR/MR body contains `<!-- issue-flow:agentrix:task=<id> -->`, a new GitHub review comment triggers `issue-flow dispatch review-comment`, adds an `eyes` reaction to acknowledge the trigger, and resumes that existing Agentrix task with the comment link. The task should reply through `issue-flow pr review-comments reply` and resolve the thread when supported.

GitHub failure intake listens to `workflow_run` completed failures. During the first install, issue-flow scans `.github/workflows/*.yml` and `.github/workflows/*.yaml` and generates the explicit upstream workflow list required by GitHub Actions. Reinstalls preserve the configured list instead of adding newly discovered workflows, so manual exclusions stay intact. To include a new workflow later, edit `.github/workflows/issue-flow-failure-intake.yml` and add it under `workflow_run.workflows`. It uses `GITHUB_TOKEN` with `actions: read` and `issues: write` to inspect failed jobs and create or update a deduped issue with `type::ops`, `failure::ci`, `flow::build`, and `automation::build`. Because issues created by `GITHUB_TOKEN` do not trigger another `issues` workflow, the failure-intake job directly resumes the normal automatic route after intake succeeds. CI failure issues still run the `build` action, but Agentrix uses the dedicated `build-ci-failure.prompt.md` template to diagnose the root cause before deciding whether to keep ops, switch to bug for a repository regression, change code, workflow config, labels, or comments.

## GitLab Configuration

GitLab has two supported paths:

- Internal service mode: GitLab project webhooks point directly at the issue-flow API service. The API service stores the project token, webhook secret, Agentrix API config, delivery records, and automation policy in PostgreSQL. The web management console is a separate Vite/React app that talks to the API over HTTP.
- Compatibility CI bridge mode: existing GitLab CI and Agentrix daemon webhook bridge behavior remains supported.

Start both the API service and web management console in development:

```bash
cp .env.dev.example .env.dev
# edit .env.dev for database, service key, public URL, and Agentrix API URL
npm run db:up
npm run db:migrate:dev
npm run dev
```

This starts PostgreSQL through Docker Compose, applies the Prisma migrations from `prisma/migrations`, loads `.env.dev`, starts the Fastify API service at `http://127.0.0.1:8788`, and starts the web console at `http://127.0.0.1:8787`.

Start the API service alone:

```bash
npm run db:migrate:dev
npm run api:dev
```

`npm run api:dev` runs `apps/api/src/main.ts` and loads `.env.dev`. Production `npm run api` loads `.env`. Start the web management console alone:

```bash
npm run web
```

`npm run web` loads `.env.dev`. The web console defaults to `http://127.0.0.1:8787` and points to `http://127.0.0.1:8788` unless `VITE_ISSUE_FLOW_API_BASE_URL` is set in `.env.dev`. Build the production web app with:

```bash
npm run web:build
```

User GitLab OAuth access and refresh tokens are stored in `oauth_sessions` and AES-GCM encrypted before they are written to PostgreSQL. OAuth sessions are used for the console user's interactive GitLab operations. Webhook dispatch uses the administrator-managed `git_servers.admin_pat` instead. Repository Agentrix API keys are encrypted in PostgreSQL. Git server rows are administrator-managed configuration rows; `git_servers.oauth_client_secret`, `git_servers.webhook_secret`, and `git_servers.admin_pat` are stored directly in PostgreSQL and are never returned by the HTTP API.

The database schema is managed by Prisma, not by application startup code. Run `npm run db:migrate:dev` locally or `npm run db:migrate` in production before starting the API. The database URL is `DATABASE_URL`.

Git server configuration is stored in explicit `git_servers` columns, not in `.env` and not in a JSON config blob. `git_servers.agentrix_git_server_id` is passed to Agentrix as `AGENTRIX_GIT_SERVER_ID`; if it is empty, issue-flow falls back to `git_servers.id`.

Insert a GitLab server before using the console:

```sql
INSERT INTO git_servers (
  id,
  type,
  name,
  base_url,
  api_url,
  token_auth,
  oauth_client_id,
  oauth_client_secret,
  oauth_redirect_uri,
  oauth_scopes,
  webhook_secret,
  agentrix_git_server_id,
  admin_pat,
  created_at,
  updated_at
) VALUES (
  'gitlab-main',
  'gitlab',
  'Internal GitLab',
  'https://gitlab.example.com',
  'https://gitlab.example.com/api/v4',
  'bearer',
  '<gitlab-oauth-app-id>',
  '<gitlab-oauth-app-secret>',
  'http://127.0.0.1:8788/api/auth/gitlab/callback',
  'api read_repository write_repository openid profile email',
  '<backend-managed-webhook-secret>',
  '<agentrix-git-server-id>',
  '<gitlab-admin-pat>',
  NOW(),
  NOW()
);
```

There is no HTTP endpoint for creating or updating Git server rows. Insert and update them in PostgreSQL as administrator-managed service configuration. The API returns only public server fields and fingerprints. OAuth client secret, webhook secret, and admin PAT are never returned to the browser. Repositories created by install store `gitServerId`, and server-side dispatch passes `agentrix_git_server_id` to Agentrix as `AGENTRIX_GIT_SERVER_ID`. GitHub is a reserved server type in this schema but is not implemented by issue-flow service yet.

Create a GitLab OAuth application for the issue-flow console and configure the callback URL on the GitLab app. The API requests the scopes saved in the selected `git_servers` row. The recommended scopes are `api read_repository write_repository openid profile email`.

In local development, set the redirect URI to:

```text
http://127.0.0.1:8788/api/auth/gitlab/callback
```

If the saved OAuth redirect URI is empty, the API derives it from the required `ISSUE_FLOW_BASE_URL` startup setting.

Production `.env` uses the same variable names. The normal production command is file-based:

```bash
cp .env.example .env
# edit .env for the production Postgres, service key, Agentrix URL, and public base URL
npm run db:migrate
npm run api
```

Minimal production variables:

```bash
ISSUE_FLOW_BASE_URL=https://issue-flow.internal \
DATABASE_URL=postgres://issue_flow:issue_flow@postgres.internal:5432/issue_flow \
ISSUE_FLOW_SERVICE_KEY_FILE=/var/lib/issue-flow/key \
ISSUE_FLOW_AGENTRIX_BASE_URL=https://agentrix.xmz.ai \
ISSUE_FLOW_API_PORT=8788 \
ISSUE_FLOW_WEB_ORIGIN=https://issue-flow-console.internal \
npm run api
```

`npm run api` runs `tsx --env-file=.env apps/api/src/main.ts`, and `apps/api/src/main.ts` also calls `dotenv.config()` for the selected env file. For container or Kubernetes deployments, mount the production `.env` file into the working directory before running `npm run api`, or inject the same variables through the platform's Secret/ConfigMap mechanism. Existing platform environment variables take precedence over values in `.env`.

Open the management page, select a Git server, and click **登录 GitLab**. The browser redirects to the selected Git server through OAuth. The API service stores the GitLab access token encrypted in PostgreSQL and returns only an httpOnly issue-flow session cookie to the browser. The console lists all projects visible to the logged-in GitLab user for that server and shows install/permission status. Projects with sufficient known access show Install immediately; projects with unknown access are allowed to attempt install and GitLab API errors are handled by the backend.

Install flow:

- Step 1: user logs in through GitLab OAuth; the API validates the OAuth access token and loads all visible projects from the backend-configured GitLab server.
- Step 2: user saves their Agentrix default API key, optional runner id, default agent, `ISSUE_FLOW_AUTO_DEFAULT`, and review switch once in the console. During project install, those defaults are applied automatically and can be overridden for that repository. Agentrix base URL is service-side configuration and defaults to `https://agentrix.xmz.ai`.
- Step 3: the API service commits the issue-flow bootstrap/skill files into the target GitLab repository, then installs the project webhook.
- GitLab server URL, GitLab OAuth application, webhook secret, and Agentrix base URL are service-side configuration, not user form fields.

The service installs the GitLab project webhook with the API service URL and backend-managed webhook secret for these project events:

- Issues events
- Comments
- Merge request events
- Pipeline events
- Job events

Direct webhook handling performs `X-Gitlab-Token` validation, delivery recording, duplicate delivery suppression, GitLab event normalization, routing to `auto`, `comment`, `review`, `review-comment`, `pr-merged`, or `pipeline-failed`, and then calls the existing issue-flow dispatch/runtime code. For GitLab API calls, issue-flow resolves the repository's linked OAuth session and refreshes it when needed. Agentrix task environments continue to have GitLab provider token variables removed.

For compatibility CI bridge mode, configure the GitLab server in Agentrix, add the daemon webhook URL and secret to the GitLab project, then push the files generated by `install.sh gitlab`. The installer creates the root `.gitlab-ci.yml` include for new projects. If `.gitlab-ci.yml` already exists, the installer keeps it by moving that content to `.gitlab/issue-flow-project.gitlab-ci.yml` and replacing the root file with a wrapper that includes both the existing pipeline and issue-flow.

Set these CI variables as needed:

- `GITLAB_TOKEN` - GitLab token with issue, merge request, and label management access
- `AGENTRIX_BASE_URL` - Agentrix API URL
- `AGENTRIX_API_KEY` - Agentrix API key, as a masked variable
- `AGENTRIX_RUNNER_ID` - optional runner id
- `AGENTRIX_ISSUE_FLOW_AGENT` - optional agent name, defaults to `codex`
- `ISSUE_FLOW_AUTO_DEFAULT` - optional automation default: `off`, `triage`, `plan`, or `build`
- `ISSUE_FLOW_REVIEW_ENABLED` - optional PR/MR review check switch, defaults to off; set to `true` or `1` to run on PR/MR opened, synchronize, ready_for_review, or manual job

GitLab label sync runs on push in `.gitlab/issue-flow.gitlab-ci.yml` and uses `GITLAB_TOKEN`, `GL_TOKEN`, `GITLAB_PRIVATE_TOKEN`, or `CI_JOB_TOKEN`. Provider tokens are only for issue-flow routing jobs; when issue-flow starts or resumes an Agentrix task, it does not forward GitLab provider token env vars into the Agentrix task environment.

GitLab failure intake is triggered by the Agentrix daemon webhook bridge for failed pipeline events. The current bridge default maps GitLab pipeline failures to `workflow_run` / `completed` events with `GITLAB_BRIDGE_WORKFLOW_RUN_CONCLUSION=failure`; older `AGENTRIX_*` bridge variables are still accepted. The failure-intake job directly resumes the build route after creating or updating the deduped issue; the GitLab auto job ignores bridge issue events that either include `failure::ci` labels or use the generated `Fix CI failure:` title so the follow-up issue webhook does not spend another runner job on duplicate routing.

GitLab review comment resume is handled by the `issue-flow-review-comment` job for Agentrix bridge `pull_request_review_comment` events and native MR note events. The dispatch command safely skips non-MR notes, closed MRs, and missing task markers, then acknowledges the trigger with an `eyes` reaction before resuming the existing Agentrix task.

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
