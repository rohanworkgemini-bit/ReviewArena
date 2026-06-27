# `@reviewarena/api` — Node API

Express + TypeScript service that ties the web app, the review-gen
Python service, and Postgres together.

## Layout

```
src/
├── server.ts            Express bootstrap + middleware
├── config.ts            Env validation (zod)
├── logger.ts            pino + pino-http with custom log levels
├── db/                  Drizzle client + schema
├── routes/
│   ├── papers.ts        POST /papers, POST /papers/arxiv, list endpoints
│   ├── papers-helpers.ts  pure utils (rate limit, slug normalization)
│   ├── reviews-stream.ts  GET /reviews/stream/:id  ← SSE bridge
│   ├── pair.ts          GET /pair, pairToken signing
│   ├── votes.ts         POST /votes (writes Elo snapshot)
│   ├── leaderboard.ts   GET /leaderboard (with bootstrap CI)
│   ├── reveal.ts        GET /reveal/:voteId (claim verdicts)
│   └── admin.ts         /admin/export.json + system management
├── elo/                 FastChat-port Elo + bootstrap CI
├── pair/                LMArena-style pair selection (upload + post-vote)
├── pipeline/            orchestrator + score-paper helpers
├── clients/             typed HTTP wrappers for review-gen + judge
└── plugins/             session middleware + admin bearer auth
```

## Hot paths

- **Upload Vote-Mode:** `POST /papers` → parse → `orchestrator.precreateReviews()`
  writes 2 pre-selected review rows in `GENERATING` status. Browser
  navigates to `/compare`, opens SSE streams.
- **SSE stream:** `GET /reviews/stream/:reviewId` opens an upstream
  stream to `review-gen /stream-generate`, forwards each token to the
  browser, persists `COMPLETED` / `FAILED` to the DB, fires the judge
  fire-and-forget.

## Dev

```bash
pnpm --filter @reviewarena/api dev          # tsx watch
pnpm --filter @reviewarena/api db:seed      # seed review_systems
pnpm --filter @reviewarena/api exec vitest  # run tests (in __tests__/)
```

## Tests

Colocated under `__tests__/`. Glob: `src/**/*.test.ts`.
