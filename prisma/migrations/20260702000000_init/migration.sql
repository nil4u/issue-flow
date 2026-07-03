-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "git_servers" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "base_url" TEXT NOT NULL,
    "api_url" TEXT NOT NULL,
    "token_auth" TEXT NOT NULL DEFAULT 'bearer',
    "oauth_client_id" TEXT NOT NULL DEFAULT '',
    "oauth_client_secret" TEXT NOT NULL DEFAULT '',
    "oauth_scopes" TEXT NOT NULL DEFAULT '',
    "webhook_secret" TEXT NOT NULL DEFAULT '',
    "agentrix_git_server_id" TEXT NOT NULL DEFAULT '',
    "admin_pat" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "git_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "avatar_url" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT 'member',
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_git_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "git_server_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "username" TEXT NOT NULL DEFAULT '',
    "display_name" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "avatar_url" TEXT NOT NULL DEFAULT '',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_git_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repos" (
    "id" TEXT NOT NULL,
    "git_server_id" TEXT,
    "server_repo_id" TEXT NOT NULL DEFAULT '',
    "owner" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "full_name" TEXT NOT NULL DEFAULT '',
    "default_branch" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repo_settings" (
    "id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL,
    "checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repo_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_repo_accesses" (
    "user_id" TEXT NOT NULL,
    "git_server_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_repo_accesses_pkey" PRIMARY KEY ("user_id","git_server_id","repo_id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" TEXT NOT NULL,
    "git_server_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "issue_number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT '',
    "priority" TEXT NOT NULL DEFAULT '',
    "size" TEXT NOT NULL DEFAULT '',
    "automation" TEXT NOT NULL DEFAULT 'off',
    "status" TEXT NOT NULL DEFAULT 'active',
    "opened_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_spans" (
    "id" TEXT NOT NULL,
    "git_server_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "issue_number" INTEGER NOT NULL,
    "flow" TEXT NOT NULL,
    "entered_at" TIMESTAMP(3) NOT NULL,
    "exited_at" TIMESTAMP(3),

    CONSTRAINT "issue_spans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "git_events" (
    "id" TEXT NOT NULL,
    "git_server_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT '',
    "object_type" TEXT NOT NULL DEFAULT '',
    "object_id" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "normalized_events" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "git_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_bridge_state" (
    "repo_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_bridge_state_pkey" PRIMARY KEY ("repo_id","key")
);

-- CreateTable
CREATE TABLE "oauth_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "access_token" TEXT NOT NULL DEFAULT '',
    "refresh_token" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_agentrix_configs" (
    "user_key" TEXT NOT NULL,
    "agentrix_api_key" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_agentrix_configs_pkey" PRIMARY KEY ("user_key")
);

-- CreateIndex
CREATE INDEX "git_servers_type_created_at_idx" ON "git_servers"("type", "created_at");

-- CreateIndex
CREATE INDEX "user_git_accounts_user_id_idx" ON "user_git_accounts"("user_id");

-- CreateIndex
CREATE INDEX "user_git_accounts_git_server_id_idx" ON "user_git_accounts"("git_server_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_git_accounts_provider_git_server_id_provider_user_id_key" ON "user_git_accounts"("provider", "git_server_id", "provider_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_git_accounts_user_id_git_server_id_key" ON "user_git_accounts"("user_id", "git_server_id");

-- CreateIndex
CREATE INDEX "repos_git_server_id_idx" ON "repos"("git_server_id");

-- CreateIndex
CREATE INDEX "repos_full_name_idx" ON "repos"("full_name");

-- CreateIndex
CREATE UNIQUE INDEX "repos_git_server_id_server_repo_id_key" ON "repos"("git_server_id", "server_repo_id");

-- CreateIndex
CREATE INDEX "repo_settings_repo_id_kind_idx" ON "repo_settings"("repo_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "repo_settings_repo_id_kind_key_key" ON "repo_settings"("repo_id", "kind", "key");

-- CreateIndex
CREATE INDEX "user_repo_accesses_user_id_git_server_id_idx" ON "user_repo_accesses"("user_id", "git_server_id");

-- CreateIndex
CREATE INDEX "user_repo_accesses_repo_id_idx" ON "user_repo_accesses"("repo_id");

-- CreateIndex
CREATE INDEX "issues_git_server_id_repository_id_state_updated_at_idx" ON "issues"("git_server_id", "repository_id", "state", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "issues_git_server_id_repository_id_issue_id_key" ON "issues"("git_server_id", "repository_id", "issue_id");

-- CreateIndex
CREATE UNIQUE INDEX "issues_git_server_id_repository_id_issue_number_key" ON "issues"("git_server_id", "repository_id", "issue_number");

-- CreateIndex
CREATE INDEX "issue_spans_git_server_id_repository_id_issue_id_idx" ON "issue_spans"("git_server_id", "repository_id", "issue_id");

-- CreateIndex
CREATE INDEX "issue_spans_flow_entered_at_idx" ON "issue_spans"("flow", "entered_at");

-- CreateIndex
CREATE INDEX "issue_spans_exited_at_idx" ON "issue_spans"("exited_at");

-- CreateIndex
CREATE INDEX "git_events_git_server_id_repository_id_received_at_idx" ON "git_events"("git_server_id", "repository_id", "received_at");

-- CreateIndex
CREATE INDEX "git_events_event_name_received_at_idx" ON "git_events"("event_name", "received_at");

-- CreateIndex
CREATE INDEX "git_events_object_type_object_id_idx" ON "git_events"("object_type", "object_id");

-- CreateIndex
CREATE UNIQUE INDEX "git_events_git_server_id_delivery_id_key" ON "git_events"("git_server_id", "delivery_id");

-- CreateIndex
CREATE INDEX "oauth_sessions_user_id_idx" ON "oauth_sessions"("user_id");

-- AddForeignKey
ALTER TABLE "user_git_accounts" ADD CONSTRAINT "user_git_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_git_accounts" ADD CONSTRAINT "user_git_accounts_git_server_id_fkey" FOREIGN KEY ("git_server_id") REFERENCES "git_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repos" ADD CONSTRAINT "repos_git_server_id_fkey" FOREIGN KEY ("git_server_id") REFERENCES "git_servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repo_settings" ADD CONSTRAINT "repo_settings_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
