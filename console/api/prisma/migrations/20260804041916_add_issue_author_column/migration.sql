-- AlterTable
ALTER TABLE "issues" ADD COLUMN     "author" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "optimization_source_issue_number" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "optimization_state" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "issues_optimization_source_idx" ON "issues"("git_server_id", "repository_id", "optimization_source_issue_number");
