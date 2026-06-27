-- The PDF is no longer persisted to disk — papers.pdf_path becomes nullable
-- so new rows can skip it. Existing rows keep their stale paths (harmless;
-- /uploads static mount is gone too). Apply with
--   pnpm --filter @reviewarena/api db:push

ALTER TABLE "papers" ALTER COLUMN "pdf_path" DROP NOT NULL;
