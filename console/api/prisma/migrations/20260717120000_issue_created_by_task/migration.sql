-- Issue provenance is independent from the Task's authoritative execution issue.
ALTER TABLE "issues"
ADD COLUMN "created_by_task_id" TEXT NOT NULL DEFAULT '';

CREATE INDEX "issues_created_by_task_id_idx"
ON "issues"("created_by_task_id");
