-- Session disconnect lifecycle + idempotent teardown.
--
-- Additive only: one nullable column, two indexes that back the lifecycle
-- reaper's queries, and a uniqueness guarantee for usage. No table rebuild and
-- no existing session/usage row is rewritten.
--
-- NOTE: the unique index on usage_records.session_id assumes the historical
-- data already has at most one row per session (the application only ever
-- wrote one at teardown). If a legacy database has duplicates, this migration
-- fails loudly on purpose: those rows represent a double-bill that needs an
-- explicit operator decision, not silent deletion.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "disconnect_deadline_at" TIMESTAMP(3);

-- CreateIndex: reaper scan for sessions whose reconnect grace has expired.
CREATE INDEX "sessions_state_disconnect_deadline_at_idx" ON "sessions"("state", "disconnect_deadline_at");

-- CreateIndex: reaper scan for stuck `terminating` rows (retry window).
CREATE INDEX "sessions_state_disconnected_at_idx" ON "sessions"("state", "disconnected_at");

-- CreateIndex: exactly one usage record per session.
CREATE UNIQUE INDEX "usage_records_session_id_key" ON "usage_records"("session_id");
