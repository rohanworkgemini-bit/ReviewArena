-- Track the session that uploaded each paper so /reviews/stream/:id can
-- authorise live model invocation (the billable path). Nullable for
-- back-compat with rows that pre-date the change.

ALTER TABLE "papers"
  ADD COLUMN IF NOT EXISTS "uploaded_by_session_id" text;
