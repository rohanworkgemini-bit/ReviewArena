# ReviewArena — Target Architecture for Scale

This document sketches how ReviewArena should evolve to handle production
load (thousands of concurrent voters, hundreds of papers per day, many
review systems) without changing the user-visible contract. It is modeled
on FastChat / Chatbot Arena (LMSYS), which is the closest comparable
deployment in the literature.

---

## 1. Current architecture (single-host)

```
            ┌────────────────────────────────────────────────────┐
            │                      Browser                        │
            │  Vite SPA · TanStack Query · /upload /compare …     │
            └────────────────────────┬───────────────────────────┘
                                     │ HTTP (cookies)
                                     ▼
            ┌────────────────────────────────────────────────────┐
            │              apps/api  (Express, 1 proc)            │
            │                                                     │
            │  /papers · /pair · /votes · /leaderboard · /admin   │
            │                                                     │
            │  in-process:                                         │
            │   • pdf-parse (CPU)                                  │
            │   • runPipeline()  — void promise, lost on restart  │
            │   • Elo computed live on every /pair, /leaderboard  │
            │   • PDFs stored on local disk (UPLOAD_DIR)          │
            └─────────┬───────────────────────┬──────────────────┘
                      │ HTTP                   │ pg
                      ▼                        ▼
        ┌───────────────────────┐    ┌──────────────────────┐
        │  services/review-gen   │   │       Neon Postgres   │
        │    (FastAPI, 1 proc)   │   │                       │
        │                        │   │   papers, reviews,    │
        │  adapters: mock, gpt,  │   │   votes, dim_votes,   │
        │  gemini, deepreviewer  │   │   elo_snapshots, …    │
        └───────────────────────┘    └──────────────────────┘
```

### Failure modes this architecture has

| Failure | Today's behavior |
|---|---|
| API restart while review-gen is running | In-flight reviews orphaned in `GENERATING` (patched with `/admin/papers/:id/regenerate`) |
| 100 simultaneous uploads | All hit the same FastAPI proc; OpenAI/Gemini rate-limited; voters wait |
| Leaderboard hit by many voters | Full vote-history scan + Elo recomputation per request |
| API host crash | Local PDFs unavailable; need re-upload |
| Adding a second API replica | Cookie-based session OK, but local uploads diverge per host |

---

## 2. Reference: FastChat / Chatbot Arena

LMSYS Chatbot Arena (the system the LMSYS Elo paper is built on) is
architecturally three things:

1. **A *controller* process** that knows which model workers are alive.
2. **A pool of *model workers*** — each model runs in its own process
   (often its own container or GPU host) and registers with the controller.
3. **A stateless *web tier*** (Gradio app + a thin OpenAI-compatible API)
   that asks the controller for a worker and forwards the request.

Votes are written append-only to Postgres (or a JSON log in early
versions). The leaderboard is **not** computed live: a separate batch
job runs the Elo + bootstrap-CI pipeline every N minutes and writes the
result to a snapshot table that the web tier reads.

Key properties this gives them:

- **Horizontal scaling**: web tier and worker tier scale independently.
- **Model isolation**: a slow / failing model can't starve the others.
- **Fast reads**: the leaderboard query is `SELECT * FROM latest_snapshot`.
- **Append-only ingestion**: a vote is a row insert; no recomputation.

---

## 3. Target architecture (ReviewArena, scale-out)

```
              ┌──────────────────────────────────────────────────────┐
              │                    Browser SPA                        │
              └──────────────────────────┬───────────────────────────┘
                                         │ HTTPS
                                         ▼
                      ┌────────────────────────────────────────┐
                      │      Load balancer / CDN edge          │
                      └──────┬─────────────────────────┬───────┘
                             │                         │
              ┌──────────────▼────────┐   ┌────────────▼───────────┐
              │  apps/api  replica 1  │   │  apps/api  replica N    │
              │  (stateless Express)  │ … │  (stateless Express)    │
              └───┬───────────┬───────┘   └────┬─────────────┬─────┘
                  │           │                │             │
                  │ enqueue   │ read snapshot  │ read PDF    │
                  ▼           ▼                ▼             ▼
        ┌────────────────┐  ┌──────────────────┐  ┌─────────────────┐
        │  Job queue     │  │   Postgres       │  │  Object storage  │
        │  (Redis +      │  │  • papers        │  │   (S3 / R2)      │
        │   BullMQ  OR   │  │  • reviews       │  │   PDFs           │
        │   pg-boss)     │  │  • votes         │  └─────────────────┘
        └──────┬─────────┘  │  • leaderboard_  │
               │            │    snapshots ◄───┐
               ▼            └──────────────────┘
   ┌────────────────────────────────┐          │
   │   review-gen workers (pool)    │          │  writes
   │                                │          │
   │  ┌───────────┐  ┌───────────┐  │   ┌──────┴─────────────┐
   │  │ worker-1  │  │ worker-N  │  │   │  Elo rebuild job   │
   │  │ adapters: │  │ adapters: │  │   │  (cron, every 30s) │
   │  │  gpt,     │  │  gemini,  │  │   │                    │
   │  │  mock     │  │  deeprev. │  │   │  reads votes,      │
   │  └───────────┘  └───────────┘  │   │  writes snapshot   │
   └────────────────────────────────┘   └────────────────────┘
```

### Component responsibilities

#### 3.1 API tier (stateless Express)

Same code as today, minus the in-process orchestrator. Each request
either:

- **Writes** (POST /papers, /votes) → enqueue a job + insert a row;
- **Reads** (GET /pair, /leaderboard) → read the snapshot table.

No filesystem state. Multiple replicas behind a load balancer. Session
cookie is HMAC-signed (stateless) — already true today.

#### 3.2 Job queue

Two reasonable choices:

| Option | Pros | Cons |
|---|---|---|
| **BullMQ on Redis** | Mature, exactly-once semantics, retries/backoff/DLQ first-class, good observability (Bull Board) | New dependency (Redis) |
| **pg-boss (Postgres)** | Reuses our existing DB; no new infra | Lower throughput; tx contention on the jobs table at high load |

Recommendation: **pg-boss** for phase 1 (no new infra), promote to
BullMQ if/when queue throughput becomes the bottleneck.

Job kinds:

- `pdf.parse` — runs `parsePdfFast` on the uploaded PDF.
- `review.generate` — one job per (paper, reviewSystem) pair.
- `elo.rebuild` — periodic; recomputes Elo + bootstrap-CI.
- `paper.score` — Checkpoint 7 LLM-judge scoring.

`POST /papers` becomes: stream PDF to object storage → insert paper row
(status=PENDING) → enqueue `pdf.parse` → return paperId. Everything else
is downstream of the queue.

#### 3.3 Review-gen workers (pool)

A worker process is a thin wrapper:

```
loop:
  job = queue.fetch(["review.generate"])
  paper = fetchPaper(job.paperId)
  parsed = fetchParsed(job.paperId)   # cached in Postgres
  review = adapter(job.adapterKey).generate(parsed, job.config)
  updateReviewRow(status=COMPLETED, structured=review)
```

Critical design choices:

- **Per-adapter concurrency limits** (`{ "gpt-5-mini": 4, "gemini-2.5-flash": 8, "deepreviewer-14b": 1 }`)
  so we don't blow the OpenAI rate limit or oversubscribe the local GPU.
  BullMQ supports this natively; pg-boss needs an in-process token
  bucket per adapter.
- **Workers are stateless** — they pull from the queue, write to
  Postgres, talk to object storage. Add more by `docker-compose up
  --scale review-gen=4`.
- **Adapter registry stays in Python** (FastAPI or a plain worker
  loop). Node side never imports adapter code — it just publishes jobs
  with an `adapterKey` string.
- **Retries**: queue retries with exponential backoff up to N times.
  After max attempts, the job is dead-lettered and the review row goes
  to `FAILED` with the last error message.

This is the direct analogue of FastChat's controller + worker split.

#### 3.4 Elo rebuild job

Today every `/pair` request does:

```ts
const history = await db.query.votes.findMany({ orderBy: asc(votes.createdAt), with: { ... } });
const elo = computeElo(history.map(...));
```

That's O(votes) per request. At 10k votes and 100 voters/sec the DB
falls over.

Target: a `leaderboard_snapshots` table:

```
leaderboard_snapshots(
  id          uuid pk,
  dimension   vote_dimension | null,   -- null = overall
  rating      jsonb,                   -- { "gpt-5-mini": 1142.3, ... }
  ci_lower    jsonb,
  ci_upper    jsonb,
  vote_count  int,
  computed_at timestamptz
)
```

A `elo.rebuild` cron job (every 30s, or after every Nth vote) does the
full scan + computeElo + bootstrapEloCI and inserts a new row.
`/pair` and `/leaderboard` read `ORDER BY computed_at DESC LIMIT 1`.

`eloSnapshots` (the existing per-vote audit table) keeps its role:
forensic history of how a single vote shifted ratings. The new
`leaderboard_snapshots` table is the **served** view.

#### 3.5 Object storage

`UPLOAD_DIR` → S3-compatible bucket (Cloudflare R2 is free egress;
AWS S3 works too). API writes PDF directly from the multipart stream;
`papers.pdfPath` becomes `papers.pdfKey` + a presigned URL is generated
on demand for `/pair`'s `pdfUrl` field.

Required for >1 API replica; otherwise hosts disagree on what PDFs
exist.

#### 3.6 Postgres

Largely unchanged. New tables: `jobs` (if pg-boss), `leaderboard_snapshots`.
Indexes to add:

- `votes(created_at)` for the Elo rebuild scan (already present).
- `reviews(paper_id, status)` for the pair eligibility check.

Neon's autoscaling tier is fine through ~100 RPS. Beyond that, move
to a primary-with-read-replica setup; pair-endpoint reads can hit the
replica.

---

## 4. Side-by-side comparison

| Concern | Today | Target |
|---|---|---|
| Review generation | In-process `void runPipeline(...)` | Durable job queue + worker pool |
| API restart safety | Orphans in-flight reviews | Jobs survive restart, retried |
| Per-adapter concurrency | None (parallel `Promise.all`) | Per-adapter token bucket |
| Leaderboard latency | O(all votes) per request | O(1) snapshot read |
| PDF storage | Local disk on API host | S3 / R2 |
| Horizontal scaling | Single API + single review-gen | N stateless API + M workers |
| Failure isolation | Slow adapter blocks request | Slow adapter → its own queue lag only |
| Sessions | Stateless signed cookie | (same) |

---

## 5. Phased migration

Each phase is independently deployable; the system stays working at
every step.

### Phase 1 — Cache the leaderboard (small, big latency win)

- New table `leaderboard_snapshots`.
- New script `scripts/rebuild-leaderboard.ts` runs Elo + bootstrap-CI.
- Run it from a `setInterval` inside the API for now (single-process OK).
- `/pair` and `/leaderboard` switch to reading the snapshot.

Risk: low. Pure read-path change. Easy to roll back.

### Phase 2 — Move review-gen behind pg-boss

- Add `pg-boss` to `apps/api`.
- `POST /papers` enqueues a `pdf.parse` job instead of running inline.
- `pdf.parse` enqueues N `review.generate` jobs.
- Workers run as a separate process (still in `apps/api`, started by a
  new `worker.ts` entry point and a `pnpm dev:worker` script).
- Per-adapter concurrency enforced with an in-process semaphore in the
  worker.
- Delete `/admin/papers/:id/regenerate` — the queue handles retries.

Risk: medium. Touches the upload happy-path. Mitigation: keep the old
in-process path behind a `USE_QUEUE` env flag for a release.

### Phase 3 — Object storage for PDFs

- Add `@aws-sdk/client-s3` to `apps/api`.
- New env: `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` (for R2).
- `papers.pdfPath` → `papers.pdfKey`.
- `/pair` returns a presigned URL with 1h TTL.
- Workers fetch PDFs from S3 instead of local disk.

Risk: low. Pure storage swap. Keep `UPLOAD_DIR` fallback for local
dev.

### Phase 4 — Multiple API replicas + worker scale-out

- Containerize: existing `Dockerfile`s + Compose for local; deploy on
  Fly/Render/Railway.
- Run 2 API replicas behind a load balancer.
- Run N worker replicas via `compose up --scale review-gen=N`.
- Add Bull Board (or pg-boss equivalent) at `/admin/queues`.

Risk: low at this point — Phases 1–3 made everything stateless.

### Phase 5 (optional) — Promote queue to Redis/BullMQ

- Only if pg-boss throughput becomes a bottleneck (unlikely below
  ~1000 jobs/sec).
- BullMQ has first-class per-adapter rate limiting and a richer
  dashboard.

---

## 6. Non-goals / explicit deferrals

- **Streaming review generation to the UI.** FastChat streams tokens
  back to the chat panel; ReviewArena reviews are batch JSON, no
  streaming needed.
- **GPU autoscaling for local adapters.** `deepreviewer-14b` is a
  research artifact; we run it on a single dedicated worker.
- **Multi-region.** Single-region with Neon (US) is enough for a
  thesis-scale deployment.
- **Authenticated users.** Anonymous sessions only; admin is a single
  bearer token.

---

## 7. Open questions

1. **Queue choice — pg-boss or BullMQ?** Phase 2 commits to one. The
   table above argues pg-boss; revisit before implementing.
2. **Snapshot rebuild cadence — time-based or vote-count-based?**
   Probably both: rebuild every 30s, or immediately after the 10th
   vote, whichever first.
3. **PDF size cap.** Currently 10 MB in `papers.ts`. Object storage
   removes the local-disk pressure, so this could be relaxed if the
   PDF parser handles bigger papers.
4. **Worker observability.** Need at minimum: per-adapter success
   rate, p50/p95 generation latency, queue depth. Prometheus +
   Grafana, or a hosted equivalent.
