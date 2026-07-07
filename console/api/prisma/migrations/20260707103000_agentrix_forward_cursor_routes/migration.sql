-- Agentrix machine ids are only unique inside a cloud. Keep migration history
-- append-only: the original task-domain migration creates machine_id cursors,
-- this migration upgrades the key to a cloud-aware route id.

ALTER TABLE "agentrix_forward_cursors"
    ADD COLUMN "route_id" TEXT,
    ADD COLUMN "cloud_id" TEXT NOT NULL DEFAULT '';

UPDATE "agentrix_forward_cursors"
SET "route_id" = "cloud_id" || ':' || "machine_id"
WHERE "route_id" IS NULL;

ALTER TABLE "agentrix_forward_cursors"
    DROP CONSTRAINT "agentrix_forward_cursors_pkey",
    ALTER COLUMN "route_id" SET NOT NULL,
    ADD CONSTRAINT "agentrix_forward_cursors_pkey" PRIMARY KEY ("route_id");
