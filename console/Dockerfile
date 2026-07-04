# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder

WORKDIR /app

ENV DATABASE_URL=postgres://issue_flow:issue_flow@127.0.0.1:5432/issue_flow
ENV ISSUE_FLOW_WEB_API_BASE_URL=

COPY package.json package-lock.json ./
COPY plugin/package.json plugin/package.json
COPY console/api/package.json console/api/package.json
COPY console/web/package.json console/web/package.json
RUN --mount=type=cache,target=/root/.npm \
  npm ci --prefer-offline --no-audit --fund=false

COPY . .
RUN npm run build -w issue-flow-console
RUN npm run build -w issue-flow-web

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV ISSUE_FLOW_API_HOST=0.0.0.0
ENV ISSUE_FLOW_API_PORT=8788
ENV ISSUE_FLOW_PLUGIN_DIR=/opt/issue-flow/plugin
ENV ISSUE_FLOW_WEB_DIST_DIR=/app/console/web/dist
ENV ISSUE_FLOW_SERVICE_KEY_FILE=/var/lib/issue-flow/key

RUN apk add --no-cache ca-certificates git openssh-client openssl \
  && addgroup -S issueflow \
  && adduser -S -G issueflow issueflow \
  && mkdir -p /var/lib/issue-flow /opt/issue-flow/plugin \
  && chown -R issueflow:issueflow /app /var/lib/issue-flow /opt/issue-flow

COPY package.json package-lock.json ./
COPY plugin/package.json plugin/package.json
COPY console/api/package.json console/api/package.json
COPY console/web/package.json console/web/package.json
RUN --mount=type=cache,target=/root/.npm \
  npm ci --omit=dev --workspace issue-flow-console --include-workspace-root=false --prefer-offline --no-audit --fund=false

COPY --from=builder --chown=issueflow:issueflow /app/console/api/dist console/api/dist
COPY --from=builder --chown=issueflow:issueflow /app/console/api/prisma console/api/prisma
COPY --from=builder --chown=issueflow:issueflow /app/console/api/prisma.config.ts console/api/prisma.config.ts
RUN cd /app/console/api \
  && DATABASE_URL=postgres://issue_flow:issue_flow@127.0.0.1:5432/issue_flow node ../../node_modules/prisma/build/index.js generate
COPY --from=builder --chown=issueflow:issueflow /app/console/web/dist console/web/dist
COPY --chown=issueflow:issueflow plugin/install.sh /opt/issue-flow/plugin/install.sh
COPY --chown=issueflow:issueflow plugin/.claude-plugin /opt/issue-flow/plugin/.claude-plugin
COPY --chown=issueflow:issueflow plugin/package.json /opt/issue-flow/plugin/package.json
COPY --chown=issueflow:issueflow plugin/skills /opt/issue-flow/plugin/skills

USER issueflow
EXPOSE 8788
VOLUME ["/var/lib/issue-flow"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.ISSUE_FLOW_API_PORT || '8788') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["sh", "-c", "cd /app/console/api && node ../../node_modules/prisma/build/index.js migrate deploy && cd /app && exec node console/api/dist/main.js"]
