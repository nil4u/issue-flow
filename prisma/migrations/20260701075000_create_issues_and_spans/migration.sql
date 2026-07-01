CREATE TABLE "issues" (
    "id" TEXT NOT NULL,
    "git_server_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "issue_number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
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

CREATE UNIQUE INDEX "issues_git_server_id_repository_id_issue_id_key" ON "issues"("git_server_id", "repository_id", "issue_id");
CREATE UNIQUE INDEX "issues_git_server_id_repository_id_issue_number_key" ON "issues"("git_server_id", "repository_id", "issue_number");
CREATE INDEX "issues_status_updated_at_idx" ON "issues"("status", "updated_at");
CREATE INDEX "issue_spans_git_server_id_repository_id_issue_id_idx" ON "issue_spans"("git_server_id", "repository_id", "issue_id");
CREATE INDEX "issue_spans_flow_entered_at_idx" ON "issue_spans"("flow", "entered_at");
CREATE INDEX "issue_spans_exited_at_idx" ON "issue_spans"("exited_at");
