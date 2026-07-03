-- AddColumns
ALTER TABLE "oauth_sessions"
ADD COLUMN "provider" TEXT NOT NULL DEFAULT '',
ADD COLUMN "git_server_id" TEXT NOT NULL DEFAULT '';

-- Backfill
UPDATE "oauth_sessions"
SET
    "provider" = COALESCE(NULLIF("data"->>'provider', ''), 'gitlab'),
    "git_server_id" = COALESCE(NULLIF("data"->>'gitServerId', ''), NULLIF("data"#>>'{gitServer,id}', ''), '');

-- Keep only the latest current session per user and Git server before adding the invariant.
DELETE FROM "oauth_sessions" old
USING "oauth_sessions" latest
WHERE old."user_id" IS NOT NULL
  AND old."user_id" = latest."user_id"
  AND old."git_server_id" = latest."git_server_id"
  AND (
    old."updated_at" < latest."updated_at"
    OR (old."updated_at" = latest."updated_at" AND old."id" < latest."id")
  );

-- CreateIndex
CREATE UNIQUE INDEX "oauth_sessions_user_id_git_server_id_key" ON "oauth_sessions"("user_id", "git_server_id");

-- CreateIndex
CREATE INDEX "oauth_sessions_git_server_id_idx" ON "oauth_sessions"("git_server_id");
