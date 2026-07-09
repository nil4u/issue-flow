CREATE TABLE "console_sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "console_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "console_sessions_token_hash_key" ON "console_sessions"("token_hash");
CREATE INDEX "console_sessions_user_id_idx" ON "console_sessions"("user_id");
CREATE INDEX "console_sessions_expires_at_idx" ON "console_sessions"("expires_at");

ALTER TABLE "console_sessions" ADD CONSTRAINT "console_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 旧世界里存在 user_id 为空的 oauth_sessions 行(仅能靠旧 cookie 的 session id 找到)。
-- 新代码一律按 (user_id, git_server_id) 查找,这些行永远不可达,直接清掉。
DELETE FROM "oauth_sessions" WHERE "user_id" IS NULL;
