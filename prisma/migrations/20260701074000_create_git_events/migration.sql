DROP TABLE IF EXISTS "webhook_deliveries";

CREATE TABLE "git_events" (
    "id" TEXT NOT NULL,
    "git_server_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT '',
    "object_type" TEXT NOT NULL DEFAULT '',
    "object_id" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "normalized_events" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "git_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "git_events_git_server_id_delivery_id_key" ON "git_events"("git_server_id", "delivery_id");
CREATE INDEX "git_events_git_server_id_repository_id_received_at_idx" ON "git_events"("git_server_id", "repository_id", "received_at");
CREATE INDEX "git_events_event_name_received_at_idx" ON "git_events"("event_name", "received_at");
CREATE INDEX "git_events_object_type_object_id_idx" ON "git_events"("object_type", "object_id");
