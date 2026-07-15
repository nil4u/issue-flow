-- CreateTable
CREATE TABLE "visual_artifacts" (
    "id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "issue_number" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "base_branch" TEXT NOT NULL DEFAULT '',
    "commit_sha" TEXT NOT NULL,
    "entry_path" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider_comment_id" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visual_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visual_reviews" (
    "id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "user_id" TEXT,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "status" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visual_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visual_artifacts_repo_id_issue_number_idx" ON "visual_artifacts"("repo_id", "issue_number");

-- CreateIndex
CREATE INDEX "visual_artifacts_status_updated_at_idx" ON "visual_artifacts"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "visual_artifacts_repo_id_issue_number_type_key" ON "visual_artifacts"("repo_id", "issue_number", "type");

-- CreateIndex
CREATE INDEX "visual_reviews_artifact_id_state_created_at_idx" ON "visual_reviews"("artifact_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "visual_reviews_user_id_idx" ON "visual_reviews"("user_id");
