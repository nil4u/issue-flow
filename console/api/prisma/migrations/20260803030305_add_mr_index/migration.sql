-- CreateIndex
CREATE INDEX "pull_requests_git_server_id_repository_id_issue_number_idx" ON "pull_requests"("git_server_id", "repository_id", "issue_number");
