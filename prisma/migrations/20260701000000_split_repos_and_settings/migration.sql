-- Replace repository runtime blobs with explicit repo identity and settings cache tables.

ALTER TABLE "credentials" DROP CONSTRAINT IF EXISTS "credentials_repo_id_fkey";
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT IF EXISTS "webhook_deliveries_repo_id_fkey";
ALTER TABLE "webhook_bridge_state" DROP CONSTRAINT IF EXISTS "webhook_bridge_state_repo_id_fkey";
ALTER TABLE "dispatch_runs" DROP CONSTRAINT IF EXISTS "dispatch_runs_repo_id_fkey";
ALTER TABLE "repositories" DROP CONSTRAINT IF EXISTS "repositories_git_server_id_fkey";
ALTER TABLE "repositories" DROP CONSTRAINT IF EXISTS "repositories_oauth_session_id_fkey";

DROP TABLE IF EXISTS "repositories";

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

CREATE TABLE "repo_settings" (
    "repo_id" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "webhook" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repo_settings_pkey" PRIMARY KEY ("repo_id")
);

CREATE TABLE "user_repo_accesses" (
    "user_id" TEXT NOT NULL,
    "git_server_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_repo_accesses_pkey" PRIMARY KEY ("user_id", "git_server_id", "repo_id")
);

CREATE UNIQUE INDEX "repos_git_server_id_server_repo_id_key" ON "repos"("git_server_id", "server_repo_id");
CREATE INDEX "repos_git_server_id_idx" ON "repos"("git_server_id");
CREATE INDEX "repos_full_name_idx" ON "repos"("full_name");
CREATE INDEX "user_repo_accesses_user_id_git_server_id_idx" ON "user_repo_accesses"("user_id", "git_server_id");
CREATE INDEX "user_repo_accesses_repo_id_idx" ON "user_repo_accesses"("repo_id");

ALTER TABLE "repos" ADD CONSTRAINT "repos_git_server_id_fkey" FOREIGN KEY ("git_server_id") REFERENCES "git_servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "repo_settings" ADD CONSTRAINT "repo_settings_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
