DROP INDEX IF EXISTS "issues_status_updated_at_idx";
CREATE INDEX "issues_git_server_id_repository_id_state_updated_at_idx" ON "issues"("git_server_id", "repository_id", "state", "updated_at");
