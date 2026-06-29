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
    "oauth_redirect_uri" TEXT NOT NULL DEFAULT '',
    "oauth_scopes" TEXT NOT NULL DEFAULT '',
    "webhook_secret" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "git_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "git_server_id" TEXT,
    "oauth_session_id" TEXT,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "repositories_git_server_id_idx" ON "repositories"("git_server_id");

-- CreateIndex
CREATE INDEX "repositories_oauth_session_id_idx" ON "repositories"("oauth_session_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_repo_id_created_at_idx" ON "webhook_deliveries"("repo_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_repo_id_delivery_key_consumer_created_at_idx" ON "webhook_deliveries"("repo_id", "delivery_key", "consumer", "created_at");

-- CreateIndex
CREATE INDEX "dispatch_runs_repo_id_created_at_idx" ON "dispatch_runs"("repo_id", "created_at");

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_git_server_id_fkey" FOREIGN KEY ("git_server_id") REFERENCES "git_servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_oauth_session_id_fkey" FOREIGN KEY ("oauth_session_id") REFERENCES "oauth_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_bridge_state" ADD CONSTRAINT "webhook_bridge_state_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_runs" ADD CONSTRAINT "dispatch_runs_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
