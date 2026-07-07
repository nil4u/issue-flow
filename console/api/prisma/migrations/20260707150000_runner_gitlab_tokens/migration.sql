CREATE TABLE "runner_gitlab_tokens" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "git_server_id" TEXT NOT NULL,
  "runner_id" TEXT NOT NULL,
  "gitlab_user_id" TEXT NOT NULL DEFAULT '',
  "gitlab_username" TEXT NOT NULL DEFAULT '',
  "gitlab_token_id" TEXT NOT NULL DEFAULT '',
  "token_ciphertext" TEXT NOT NULL DEFAULT '',
  "token_fingerprint" TEXT NOT NULL DEFAULT '',
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source" TEXT NOT NULL DEFAULT '',
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "runner_gitlab_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "runner_gitlab_tokens_user_id_git_server_id_runner_id_key"
  ON "runner_gitlab_tokens"("user_id", "git_server_id", "runner_id");

CREATE INDEX "runner_gitlab_tokens_git_server_id_runner_id_idx"
  ON "runner_gitlab_tokens"("git_server_id", "runner_id");

CREATE INDEX "runner_gitlab_tokens_user_id_idx"
  ON "runner_gitlab_tokens"("user_id");

ALTER TABLE "runner_gitlab_tokens"
  ADD CONSTRAINT "runner_gitlab_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "runner_gitlab_tokens"
  ADD CONSTRAINT "runner_gitlab_tokens_git_server_id_fkey"
  FOREIGN KEY ("git_server_id") REFERENCES "git_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
