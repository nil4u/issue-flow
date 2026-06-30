# Issue Flow Web Console

Vite + React management console for the separated issue-flow internal platform.
This app owns UI only; REST APIs and GitLab webhook routes live in `apps/api`.

## Development

Start both API and web from the repository root:

```bash
cp .env.dev.example .env.dev
npm run dev
```

This loads `.env.dev` and wires `VITE_ISSUE_FLOW_API_BASE_URL` automatically.
Git server and OAuth configuration are stored in the API database. Insert a
GitLab row through `/api/git-servers` before logging in:

```bash
curl -X POST http://127.0.0.1:8788/api/git-servers \
  -H 'Content-Type: application/json' \
  --data '{"id":"gitlab-main","type":"gitlab","baseUrl":"https://gitlab.example.com","apiUrl":"https://gitlab.example.com/api/v4","oauth":{"clientId":"<id>","clientSecret":"<secret>","redirectUri":"http://127.0.0.1:8788/api/auth/gitlab/callback","scopes":"api read_repository write_repository openid profile email"},"webhook":{"secret":"<webhook-secret>"}}'
```

For local development, the GitLab OAuth redirect URI is:

```text
http://127.0.0.1:8788/api/auth/gitlab/callback
```

Start the API service alone in local development:

```bash
npm run api:dev
```

Start the web console alone:

```bash
npm run web
```

The web console loads `.env.dev`, defaults to `http://127.0.0.1:8787`, and points to `http://127.0.0.1:8788` unless `VITE_ISSUE_FLOW_API_BASE_URL` is set in `.env.dev`. Production build and preview scripts load `.env`.

## Design System

**一切设计必须来自设计系统的颜色和组件**。

Use shadcn/ui components from `src/components/ui` first, then apply the reusable
`neumo-*` classes from `src/index.css` when the issue-flow micro-neumorphic
treatment is appropriate.

Add shadcn components in small batches:

```bash
npx shadcn@latest add button input label card dialog sheet
```
