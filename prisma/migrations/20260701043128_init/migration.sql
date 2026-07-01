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
    "oauth_redirect_uri" TEXT NOT NULL DEFAULT '',
    "oauth_scopes" TEXT NOT NULL DEFAULT '',
    "webhook_secret" TEXT NOT NULL DEFAULT '',
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
CREATE TABLE "credentials" (
    "repo_id" TEXT NOT NULL,
    "webhook_secret" TEXT NOT NULL DEFAULT '',
    "agentrix_api_key" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("repo_id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "delivery_key" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "dispatch_runs" (
    "id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispatch_runs_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "webhook_deliveries_repo_id_created_at_idx" ON "webhook_deliveries"("repo_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_repo_id_delivery_key_consumer_created_at_idx" ON "webhook_deliveries"("repo_id", "delivery_key", "consumer", "created_at");

-- CreateIndex
CREATE INDEX "dispatch_runs_repo_id_created_at_idx" ON "dispatch_runs"("repo_id", "created_at");

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
