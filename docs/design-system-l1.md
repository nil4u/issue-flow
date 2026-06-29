# L1 Design System Contract

Issue Flow web UI must use the local design system as the source of visual truth.

**一切设计必须来自设计系统的颜色和组件**。

Rules:

- All production UI must be composed from shadcn/ui components in `apps/web/src/components/ui` or small wrappers around them.
- All color decisions must come from design-system CSS variables in `apps/web/src/index.css`.
- Custom styling may use `color-mix()` with those variables, but must not introduce unrelated hardcoded palettes.
- Buttons, cards, fields, badges, dialogs, repository rows, and navigation states must preserve the issue-flow micro-neumorphic treatment where it improves scanability.
- Provider tokens, webhook secrets, and Agentrix API keys must never be displayed as raw values; only one-time secret reveal and fingerprints are allowed.

Architecture:

- `apps/web` is UI only.
- `apps/api` owns REST routes and webhook routes.
- `apps/api/src/core` owns API-internal repository config, credential storage, GitLab webhook normalization, delivery dedupe, dispatch routing, and token sanitization.
