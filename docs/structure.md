# ReviewArena — System map

A single-pager for orienting in the repo. For the higher-level system
diagram see [architecture.md](./architecture.md); for thesis context see
the proposal under `research/ReviewArena.pdf`.

## Top-level layout

```
review-arena/
├── apps/                 Long-running services with user-facing surfaces
│   ├── api/              Node/Express + Drizzle (port 8000)
│   └── web/              React + Vite SPA (dev port 5173)
├── services/             Out-of-process Python / GPU services
│   ├── review-gen/       FastAPI: adapters + parsers + judge (port 8001)
│   └── modal/            Modal GPU apps (one subdir per model)
├── packages/
│   └── shared-types/     Zod + TS schemas shared by api + web
├── docs/                 Architecture, fairness, external adapter plan
├── scripts/              One-off shell + Python tooling
└── research/             Thesis materials (gitignored caches + proposal)
```

Each top-level package has its own `README.md` with details.

## The data path of one upload

```
                    ┌─────────────┐
[browser]  ──POST── │   /papers   │  Node — hash + dedup + insert paper
                    └──────┬──────┘
                           │ background runPipeline()
                           ▼
                    parse via Datalab Chandra API (hosted /convert)
                       OR arxiv2md (timf34's free hosted service)
                           │
                           ▼
                  selectUploadPair() — LMArena weighted pick of 2 slugs
                           │
                           ▼
                  orchestrator.precreateReviews()
                  inserts 2 review rows in GENERATING status (no model call)
                           │
[browser]  ◀── 201 ◀───────┘
[browser]  navigates to /compare?paperId=X
[browser]  ──GET─── /papers/:id ─── learns reviewIds for the chosen pair
[browser]  opens 2 EventSource streams to /reviews/stream/:reviewId
                           │
                           ▼
              Node /reviews/stream/:reviewId
              ──HTTP SSE── review-gen /stream-generate
                           │
                           ▼
              Adapter.generate_stream(paper)
              yields token / done / error events
              ──forward──► browser renders live caret + structured swap
              ──persist──► reviews row → COMPLETED + structured + rawOutput
              ──fire──► judge claim extraction (background)
```

## Architectural invariants

These guarantees are load-bearing — break them and downstream code
silently misbehaves.

### A1 — Canonical `ParsedPaper`

Every parser (Datalab Chandra, arxiv2md, mock) produces the **same shape**
(see `packages/shared-types/src/parsed-paper.ts`). Adapters depend on
this shape, not on which parser ran. Adding a new parser means
emitting that shape; never invent a parser-specific variant.

### A2 — Canonical `StructuredReview`

Every adapter emits the same `StructuredReview` (summary, strengths,
weaknesses, questions, soundness, presentation, contribution,
overallRating, confidence). Markdown / chain-of-thought / wrappers
are normalised inside the adapter; the orchestrator + judge + UI see
only the canonical shape.

### A3 — Pair selected once, then frozen

The pair is chosen at upload time via `selectUploadPair()` and stored
as a `pairToken` (HMAC-signed) on the client. Reload / refresh /
re-poll never re-rolls — the same `pairToken` always resolves to the
same two review rows. This makes votes auditable and reproducible.

### A4 — Fair input budget

Every adapter receives **the same byte-identical paper text** for a
given paper (see `services/review-gen/app/adapters/_budget.py` and
`paper_render.py`). Differences in review quality therefore reflect
the model + prompt, not how much of the paper each system got to read.

### A5 — One-flight per review

Each `reviewId` is generated **at most once**. The Node SSE bridge
holds an in-memory mutex per `reviewId`; a second opener awaits the
primary, then replays the now-terminal state. This prevents two
streams from double-billing the GPU for the same review.

### A6 — Modal services are auth-gated

Every Modal endpoint URL is technically public. We mount a
`modal-shared-auth` secret that vLLM checks via `--api-key`; our Node
adapters send the same secret in `X-Modal-Auth`. Without that header,
the Modal endpoint returns 401.

## Where to change things

| Want to… | Edit… |
|---|---|
| Add a new vLLM-served review model | `services/modal/<name>/`, then `services/review-gen/app/adapters/<name>.py`, then `apps/api/scripts/seed.ts` |
| Add a new VoteDimension | `packages/shared-types/src/dimensions.ts`, then `db:seed` |
| Change the SSE protocol | `services/review-gen/app/main.py::stream_generate` + `apps/api/src/clients/review-gen-client.ts::streamGenerate` + `apps/web/src/hooks/useReviewStream.ts` |
| Tune pair-selection weights | `apps/api/src/pair/select-pair.ts` (per-system knobs live in `review_systems` DB table) |
| Change judge prompt / model | `services/review-gen/app/judge.py` |
| Add a new parser | `services/review-gen/app/parsing/<name>.py` + re-export in `parsing/__init__.py` |
| Add an API endpoint | new file in `apps/api/src/routes/` + register in `server.ts` |

## Conventions

- **Tests** live in `__tests__/` colocated with the module they cover.
  Glob: `src/**/*.test.ts`. Pure helpers and pure transformations are
  the priority for unit tests; SSE + DB integration is exercised in
  hand-run end-to-end smoke tests.
- **Comments** are reserved for *why*, not *what*: invariants, hidden
  constraints, citations to upstream papers, workarounds. Code that
  describes itself doesn't get commented.
- **No new abstractions until at least three duplications.** The
  adapter helper trio (`_budget.py`, `_review_parse.py`,
  `vllm_base.py`) was extracted after we had three vLLM-served
  models, not before.
- **Background work uses fire-and-forget `Promise<void>` / `void` +
  `.catch`** — never `await` the judge or the orchestrator from
  inside an HTTP handler.
