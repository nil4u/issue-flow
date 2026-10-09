ALTER TABLE "git_servers"
  ADD COLUMN "github_app_id" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "github_app_slug" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "github_private_key" TEXT NOT NULL DEFAULT '';
