ALTER TABLE "git_servers"
  ADD COLUMN "agentrix_git_server_id" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "admin_pat" TEXT NOT NULL DEFAULT '';
