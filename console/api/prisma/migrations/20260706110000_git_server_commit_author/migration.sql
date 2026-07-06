ALTER TABLE "git_servers"
  ADD COLUMN "commit_author_name" TEXT NOT NULL DEFAULT 'issue-flow',
  ADD COLUMN "commit_author_email" TEXT NOT NULL DEFAULT '';
