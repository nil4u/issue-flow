ALTER TABLE "user_git_accounts"
ADD COLUMN "personal_access_token" TEXT NOT NULL DEFAULT '',
ADD COLUMN "personal_access_data" JSONB NOT NULL DEFAULT '{}'::jsonb;
