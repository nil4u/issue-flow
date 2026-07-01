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

-- AlterTable
ALTER TABLE "oauth_sessions" ADD COLUMN "user_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "user_git_accounts_provider_git_server_id_provider_user_id_key" ON "user_git_accounts"("provider", "git_server_id", "provider_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_git_accounts_user_id_git_server_id_key" ON "user_git_accounts"("user_id", "git_server_id");

-- CreateIndex
CREATE INDEX "user_git_accounts_user_id_idx" ON "user_git_accounts"("user_id");

-- CreateIndex
CREATE INDEX "user_git_accounts_git_server_id_idx" ON "user_git_accounts"("git_server_id");

-- CreateIndex
CREATE INDEX "oauth_sessions_user_id_idx" ON "oauth_sessions"("user_id");

-- AddForeignKey
ALTER TABLE "user_git_accounts" ADD CONSTRAINT "user_git_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_git_accounts" ADD CONSTRAINT "user_git_accounts_git_server_id_fkey" FOREIGN KEY ("git_server_id") REFERENCES "git_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
