# ReviewArena — Implementation Walkthrough

A talk-track for the supervisor meeting. Organised so you can either read it
top-to-bottom (≈15 min) or pick the section that gets challenged.

---

## 1. What the project answers

Two research questions from the proposal:

1. **How well does human pairwise preference (Elo) correlate with automatic
   metrics** (BLEU, ROUGE, LLM-as-judge)?
2. **How do different review systems rank across evaluation dimensions**
   (Actionability, Verifiability, Helpfulness, …)?

ReviewArena is the apparatus that produces the data to answer those. It is
modelled on LMSYS Chatbot Arena (LMArena) and reuses their Elo algorithm —
the contribution is *the platform*, not new Elo math.

**One-sentence positioning**: a continuously-growing, blind, human-judged
benchmark for automated peer-review systems, with paired automatic-metric
ground truth so the human-vs-metric correlation can be measured.

---

## 2. End-to-end user flow (the demo path)

```
   Upload PDF  ─►  Parse  ─►  Generate reviews (fan-out to all systems)
                                       │
                                       ▼
                              Auto-score each review
                              (LLM-judge + ClaimChecks)
                                       │
                                       ▼
   Browse to /compare  ─►  Pair endpoint picks 2 reviews
                          (Elo-proximity weighted)
                                       │
                                       ▼
   Voter picks A / B / Tie + optional 8 dimensions
                                       │
                                       ▼
   Submit vote  ─►  Append-only insert  ─►  Elo snapshot  ─►  Reveal
                                                              │
                                          ┌───────────────────┘
                                          ▼
                      Reveal screen shows system identities,
                      Elo before/after, radar of judge scores,
                      paper-grounded claim verdicts
```

If asked "show me the demo":
1. `npm run dev` — boots review-gen :8001, api :8000, web :5173.
2. Open <http://localhost:5173>, click **Upload paper**, drop a text-PDF.
3. Wait ~30 s while GPT, Gemini, AI-Scientist all finish.
4. Auto-routes to `/compare`. Read both reviews, vote.
5. Reveal page shows identities + Elo delta + radar + claim verdicts.

---

## 3. Architecture in one picture

```
   ┌──────────────┐       ┌──────────────────┐       ┌──────────────────────┐
   │  React SPA   │──HTTP─│  Express API     │──HTTP─│   FastAPI            │
   │  (apps/web)  │       │  (apps/api)      │       │  (services/review-   │
   │              │       │                  │       │   gen)               │
   └──────────────┘       └────┬──────┬──────┘       └────────┬─────────────┘
                               │      │                       │
                       Postgres│      │ local FS              │ adapters
                       (Neon)  │      │ uploads/              │
                               ▼      ▼                       ▼
                       ┌──────────────┐               ┌─────────────────────┐
                       │  8 tables    │               │  mock, gpt-5-mini,  │
                       │  + 7 enums   │               │  gemini-2.5-flash,  │
                       │              │               │  ai-scientist,      │
                       │  Drizzle ORM │               │  deepreviewer (stub)│
                       └──────────────┘               └─────────────────────┘
```

**Three processes, one repo (monorepo via pnpm workspaces).**

- *Why split the Python service?* DeepReviewer / BERTopic / ROUGE / BLEU are
  Python-native ML libraries. Node calls them over HTTP so the API tier
  stays language-pure TS and the Python service stays a thin model server.
- *Why Express not Fastify?* Originally Fastify; switched after Fastify's
  Set-Cookie was being silently dropped from `onRequest` hooks. Documented
  in README §Decisions log.
- *Why Drizzle not Prisma?* Drizzle infers TS types from the schema file —
  no codegen step. Same Postgres schema either way.

---

## 4. File layout — what lives where

```
reviewarena/
├── apps/
│   ├── web/                       # React + Vite + TS + Tailwind + shadcn/ui
│   │   └── src/
│   │       ├── pages/             # Leaderboard, Upload, Comparison, Reveal, Admin
│   │       ├── components/{ui,layout}
│   │       └── lib/{api,cn}
│   └── api/                       # Express + Drizzle + Zod
│       ├── scripts/               # CLI: seed.ts, drop-all.ts, inspect.ts
│       └── src/
│           ├── db/                # schema.ts, client.ts
│           ├── clients/           # review-gen-client.ts, judge-client.ts
│           ├── pipeline/          # orchestrator.ts, score-paper.ts
│           ├── parsing/           # pdf-parse.ts
│           ├── elo/               # elo.ts + tests (FastChat port)
│           ├── pair/              # select-pair.ts + tests
│           ├── routes/            # papers, pair, votes, leaderboard, reveal, admin
│           ├── plugins/           # session.ts, admin-auth.ts
│           └── server.ts
├── services/
│   └── review-gen/                # FastAPI; /generate, /judge, /metrics, /analytics
│       └── app/
│           ├── adapters/{mock,gpt,gemini,ai_scientist,deepreviewer}.py
│           ├── judge.py           # LLM-as-judge
│           ├── metrics.py         # BLEU + ROUGE
│           └── analytics.py       # BERTopic + word freq
├── packages/
│   └── shared-types/              # Zod schemas + TS types (one source of truth)
├── scripts/
│   └── thesis_eval.py             # admin export → CSVs + Elo trajectory plot
├── docs/
│   ├── architecture.md            # scale-out target architecture
│   └── walkthrough.md             # this file
├── research/                      # thesis material (proposal PDF, mockups)
└── docker-compose.yml             # Postgres + GROBID for local dev
```

Three pieces to call out:

- **`packages/shared-types`** — Zod schemas (`SubmitVoteRequestSchema`,
  `PairResponseSchema`, …). Imported by both apps/api and apps/web so
  the wire format is one source of truth. Pydantic mirrors in
  `services/review-gen/app/schemas.py` to keep the Python boundary in sync.
- **`apps/api/src/pipeline/`** — the upload-to-reveal critical path
  (`orchestrator.ts` + `score-paper.ts`). Read this folder first if a
  reviewer asks "how does a paper become a reveal screen?".
- **`scripts/thesis_eval.py`** — turns the admin JSON export into the four
  CSVs/plots that the thesis analysis chapter consumes.

---

## 5. Database schema — 8 tables, 7 enums

Source of truth: [apps/api/src/db/schema.ts](../apps/api/src/db/schema.ts).

| Table | Purpose | Key invariant |
|---|---|---|
| `papers` | Uploaded PDF + parsed structure + status | `contentHash` is unique → re-upload reuses the row |
| `reviewSystems` | The benchmarkable systems (mock-a, gpt-5-mini, …) | `slug` unique; `enabled` toggles inclusion in fan-out |
| `reviews` | One review per (paper, system) | Unique `(paperId, reviewSystemId)` enforces cache-once |
| `votes` | One per user A/B/Tie decision | `sessionId` is the only identity (anonymous cookie) |
| `dimensionVotes` | Optional per-dimension slider, child of `votes` | Unique `(voteId, dimension)` — one slider per dim per vote |
| `eloSnapshots` | Append-only Elo history (overall + per-dimension) | `triggerVoteId` references the vote that caused the snapshot |
| `metricScores` | LLM-judge overall + verifiability + (in `meta.dimension_scores`) the 8-dim radar | Unique `(reviewId, kind, referenceType)` so we cache once |
| `claimChecks` | Per-claim verdict from the LLM judge | Cleared and rewritten when scoring re-runs |

**Why all this for 8 tables?** Because the spec wants both human votes AND
automatic metrics for correlation analysis. Keeping them in the same DB
lets `thesis_eval.py` join on `reviewId` without ETL.

---

## 6. The Elo math (Phase 1 deliverable)

[apps/api/src/elo/elo.ts](../apps/api/src/elo/elo.ts). Ported from
**LMSYS FastChat** (Apache 2.0, credit comment in-file).

Constants — verbatim from FastChat:
```
K = 4
BASE = 10
SCALE = 400
INIT_RATING = 1000
```

Two functions:

- **`computeElo(battles)`** — replays the entire battle history in order.
  Returns `Map<slug, rating>`. O(N) over votes.
- **`bootstrapEloCI(battles, nResamples)`** — for each resample, sample
  battles with replacement, run `computeElo`, store the resulting rating
  per system. 95% CI is the [2.5, 97.5] percentile of each system's rating
  distribution. Default 100 resamples in production (1000 in tests).

**Why K = 4 and not the classic 32?** Because we *replay* the full history
on every snapshot rather than mutating incrementally. With K = 32 the most
recent vote would dominate the rating. K = 4 matches FastChat's choice for
this batch-replay style.

**Why bootstrap CI?** Two reasons:
1. Closed-form Bradley-Terry variance assumes battles are i.i.d.; ours
   aren't (matchmaking is biased toward close-rated pairs).
2. The spec wants the leaderboard to show "±42" style confidence bands —
   bootstrap gives them honestly.

15 unit tests cover the Elo functions + 7 cover pair selection — these
are the correctness-critical pieces of the system.

---

## 7. Pair selection — how we pick what to show next

[apps/api/src/pair/select-pair.ts](../apps/api/src/pair/select-pair.ts).

**Algorithm**:
1. For each ordered pair (i, j) of eligible reviews on the same paper,
   compute `proximity = 1 / (1 + |rating_i − rating_j|)`.
2. Down-weight pairs the current session has already voted on, by ×0.1.
3. Sample one pair proportional to weight.
4. Coin-flip which becomes "A" vs "B" — actual blinding step.

**Why not greedy closest-pair?** Once two systems' ratings stabilise,
greedy would show the same pair forever and starve every other pairing
of data. The probabilistic weighting concentrates votes on informative
pairs without monopolising.

**Eligibility gate** in [routes/pair.ts:57-89](../apps/api/src/routes/pair.ts#L57-L89):
all enabled adapters must have reached a terminal state (COMPLETED or
FAILED). Otherwise fast adapters (mock = 7 ms) would dominate the
comparison window while GPT/Gemini are still generating (~30 s) — voters
would see mostly mock-vs-mock and the Elo signal for slow systems would
be starved.

---

## 8. Pair token (security against vote tampering)

[apps/api/src/routes/pair.ts:20-38](../apps/api/src/routes/pair.ts#L20-L38).

When `/pair` returns a chosen pair, it also returns a **HMAC-SHA256
signature** over `(paperId, reviewAId, reviewBId, sessionId)`. The key is
`ADMIN_TOKEN` from `.env`.

`/votes` verifies that signature before recording the vote. Two properties
that buys us:

1. **Stateless** — no server-side pair table to keep in sync; pair state
   lives in the token itself.
2. **Anti-tamper** — a voter can't swap reviewA/reviewB to cheat the
   blinding, can't replay another session's pair, and can't manufacture
   a vote against a pair they never saw.

Constant-time comparison in `verifyPairToken` to avoid the obvious side
channel.

---

## 9. The orchestrator — review fan-out + auto-scoring

[apps/api/src/pipeline/orchestrator.ts](../apps/api/src/pipeline/orchestrator.ts).

On upload, after parsing succeeds:
1. Look up all `enabled` review systems.
2. **`Promise.all`** over them — every adapter starts in parallel. The
   user waits `max(call)` not `sum(call)`.
3. Each `generateOne` inserts a `GENERATING` row, calls the FastAPI
   adapter, updates the row to `COMPLETED` (with structured payload) or
   `FAILED` (with error message).
4. **Auto-score**: once all reviews are terminal, `scorePaper()` runs the
   LLM judge over every COMPLETED review and writes ClaimCheck +
   MetricScore rows. Best-effort — a judge failure does NOT poison the
   generation pipeline (admin can re-run via `/admin/papers/:id/score`).

**Why auto-score in the orchestrator and not on /reveal demand?** Because
the judge is slow (10–20 s per review) and we don't want the voter staring
at "loading" on the reveal page. Pre-computing makes the reveal an O(1)
read.

---

## 10. The Python adapter layer

[services/review-gen/app/adapters/__init__.py](../services/review-gen/app/adapters/__init__.py).

A **registry pattern**. Each adapter declares an `adapter_key` and
implements `Adapter.generate(paper) -> GenerationResult`. The registry
maps the key to a lazy factory so the OpenAI client isn't imported when
the user only wants the mock adapter.

Current adapters:

| Key | Class | What it is |
|---|---|---|
| `mock` | `MockAdapter` | Deterministic local mock for offline dev. Two seeded variants (`mock-a`, `mock-b`) registered. |
| `gpt-4o-mini` | `GPTAdapter` | OpenAI chat completion. Zero-shot NeurIPS-style prompt. Currently configured for `gpt-5-mini`. |
| `gemini` | `GeminiAdapter` | Google Generative AI. Same zero-shot prompt, JSON-mode output. `gemini-2.5-flash`. |
| `ai-scientist` | `AIScientistAdapter` | Sakana AI's reviewer module (Lu et al. 2024). NeurIPS rubric + 1 self-reflection round. ~3 OpenAI calls per review. |
| `deepreviewer` | `DeepReviewerAdapter` | WestlakeNLP/DeepReviewer-14B HF checkpoint. **Disabled** — needs a GPU host. |

All adapters return the same `StructuredReview` Pydantic shape (summary,
strengths, weaknesses, questions, soundness, presentation, contribution,
overall, confidence). That uniformity is what lets the comparison UI
treat any pair of systems the same way.

**Adding a new system**: write a Python class, register it in
`adapters/__init__.py`, add a row to `scripts/seed.ts`, run `db:seed`.
Done — no schema migration, no API change.

---

## 11. The LLM-as-judge

[services/review-gen/app/judge.py](../services/review-gen/app/judge.py).

For each `(review, paper)` pair the judge:
1. Splits the review into discrete **claims**.
2. For each claim, finds supporting / contradicting evidence in the paper
   text and returns `SUPPORTED / CONTRADICTED / UNSUPPORTED`.
3. Returns an **overall score** (1–10) for review quality.
4. Returns a **verifiability score** = `supported / total_claims`.
5. Returns **per-dimension scores** (the same 8 dimensions voters can
   slide on).

The per-dimension scores are what populate the reveal screen's radar
chart. They're stored in `metricScores.meta.dimension_scores` on the
`LLM_JUDGE_OVERALL` row — single jsonb payload instead of 8 new enum
values (cleaner schema, same data).

**Why this matters for the thesis**: this is one half of the correlation
analysis. Human votes are the other half. Joining the two by `reviewId`
in `thesis_eval.py` produces `human_vs_judge.csv` — the central artefact
of the analysis chapter.

---

## 12. Vote ingestion — what happens when the user clicks

[apps/api/src/routes/votes.ts](../apps/api/src/routes/votes.ts).

Pseudocode of the whole route:

```
1. Zod-validate body  →  400 on shape mismatch
2. verifyPairToken  →  401 if HMAC fails
3. Fetch both reviews + their systems (parallel)
4. outcome = body.winner === "A" ? 1 : "B" ? 0 : 0.5
5. eloBefore = computeElo(history)[slug]
6. eloAfter = incrementalEloUpdate(eloBefore, …)
7. BEGIN TRANSACTION
     INSERT vote
     INSERT dimensionVotes (if any)
   COMMIT
8. snapshotLeaderboard(voteId, null)       — overall
   for each dimension voted on:
     snapshotLeaderboard(voteId, dim)      — per-dim
9. 201 { voteId, reveal: { eloBefore/after for both sides } }
```

**Why store both `eloBefore` and `eloAfter` in the response?** The reveal
screen renders the "+8 / −8" delta inline, without needing a follow-up
query. The actual leaderboard reads the latest `eloSnapshot` row, not
this response.

**Why an EloSnapshot per dimension per vote?** Because each dimension has
its own leaderboard. A vote that slid Comprehensiveness toward A but
Clarity toward B updates two different sub-leaderboards. The snapshot
table is the historical log of every leaderboard movement, partitioned
by `dimension`.

---

## 13. The reveal screen — closing the loop

[apps/web/src/pages/RevealPage.tsx](../apps/web/src/pages/RevealPage.tsx)
+ [apps/api/src/routes/reveal.ts](../apps/api/src/routes/reveal.ts).

Two data sources merged:

- **In-URL state** (from `/votes` response): system slug, name, Elo before /
  after. No round-trip needed for the top cards.
- **`GET /reveal/:voteId`**: ClaimCheck list (with evidence excerpts) +
  per-dimension judge scores. Polled every 3 s until populated (orchestrator
  may still be running the judge when the user lands here).

UI shows three sections:
1. **Top cards** — system identities + Elo delta + judge-overall + verifiability %
2. **Radar chart** — Recharts polar chart, 8 dimensions, A vs B
3. **ClaimCheck lists** — each claim badged SUPPORTED (green) / CONTRADICTED
   (red) / UNSUPPORTED (amber), with evidence excerpt

This is *the screen* that demonstrates the system's claim: it shows the
voter's subjective preference next to the LLM-judge's structured opinion
on the same two reviews. The "do humans and judges agree?" question is
visible in one screen per vote.

---

## 14. The leaderboard

[apps/web/src/pages/LeaderboardPage.tsx](../apps/web/src/pages/LeaderboardPage.tsx)
+ [apps/api/src/routes/leaderboard.ts](../apps/api/src/routes/leaderboard.ts).

Reads the latest `eloSnapshot` row per `(reviewSystemId, dimension)`. The
SPA exposes a dimension toggle — selecting "Clarity" switches to the
Clarity sub-leaderboard.

Columns mirror the spec's Screen 1 mockup: rank, system, rating, ±CI,
votes.

---

## 15. The 8 dimensions

In [packages/shared-types/src/dimensions.ts](../packages/shared-types/src/dimensions.ts):
COMPREHENSIVENESS, CLARITY, FAIRNESS, ACTIONABILITY, CONSTRUCTIVENESS,
OBJECTIVITY, RELEVANCE, TECHNICAL_TERMS.

The proposal text mentions 3 examples (Actionability, Verifiability,
Helpfulness); the proposal mockup shows 5 (Comprehensiveness, Specificity,
Constructiveness, Accuracy, Structure); the May 2026 thesis mockup shows
8. We took the 8 from the canonical mockup. README §Decisions log
documents the choice — be ready to defend it as "the most recent design
mockup is the source of truth."

---

## 16. PDF parsing

[apps/api/src/parsing/pdf-parse.ts](../apps/api/src/parsing/pdf-parse.ts).

Fast path: `pdf-parse` library extracts text, heuristic regex detects
section headings (`^[A-Z][\w \-:]{2,60}$` plus optional numeric prefix).
Section list + title + abstract → `ParsedPaper`.

**EmptyPdfError**: if extracted text < 200 chars, we throw rather than
hallucinate. Image-only PDFs (scans) hit this — we refuse them up-front so
the LLM adapters aren't asked to review nothing.

**GROBID fallback**: docker-compose includes GROBID. Not wired into the
hot path yet — pdf-parse is good enough for the demo; the spec calls
GROBID a "primary parser" but in practice it's slow to warm. Easy
swap-in: a `GrobidParser` class behind the same `parsePdf` interface.

---

## 17. Sessions, anonymity, admin

- **Anonymous httpOnly cookie** ([apps/api/src/plugins/session.ts](../apps/api/src/plugins/session.ts)) — one ID per browser, never sent to anything outside the app. No IP, no email, no fingerprint column. Privacy story for the ethics chapter: nothing collected from voters except their session ID + browser UA + votes.
- **Pair token HMAC** — already covered.
- **Admin** ([apps/api/src/routes/admin.ts](../apps/api/src/routes/admin.ts)): bearer-token-protected. CRUD on `reviewSystems` (POST / PATCH / toggle / DELETE — DELETE refuses if reviews reference the system), regenerate stuck reviews, manual `/score` re-run, and `export.json` / `export.csv`. UI at [apps/web/src/pages/AdminPage.tsx](../apps/web/src/pages/AdminPage.tsx) — operator pastes token, toggles systems, deletes unused.

---

## 18. Data the system collects (the thesis dataset)

For each vote:
- `winner ∈ {A, B, TIE}`, `decisionMs`, `sessionId`, `userAgent`, `createdAt`
- 0–8 `dimensionVotes`, each in `[-2, +2]`
- The pair shown — reviewA / reviewB ids → systems

For each review:
- `structured` (the model's JSON output), `rawOutput`, `generationMs`
- `LLM_JUDGE_OVERALL` (1–10), `LLM_JUDGE_VERIFIABILITY` (0–1), 8 per-dim judge scores
- `ClaimCheck` rows: one per claim, with verdict + evidence excerpt

For each leaderboard movement:
- An `eloSnapshot` per (system, dimension, vote) with rating, CI low, CI high, vote count

`scripts/thesis_eval.py` consumes the admin JSON export and emits:

- `votes_long.csv` — one row per vote, dimension columns flattened
- `head_to_head.csv` — pairwise win/loss/tie counts between systems
- `elo_trajectory.png` — per-system Elo over time, 95% CI shaded
- `human_vs_judge.csv` — winrate vs judge mean per system

Those four files are the inputs to the thesis analysis chapter.

---

## 19. Testing & confidence

```bash
pnpm --filter @reviewarena/api test      # 26 tests, all green
pnpm --filter @reviewarena/api typecheck
pnpm --filter @reviewarena/web typecheck
```

- 15 tests on Elo math (computeElo monotonicity, bootstrap convergence,
  init rating, K-factor effect)
- 7 tests on pair selection (proximity weighting, seen-pair penalty,
  uniform when all equal)
- 4 tests on the pair-token HMAC (sign-verify roundtrip, tamper detection,
  cross-session rejection)

The spec calls Elo + pair selection the correctness-critical pieces;
those are where the deepest coverage lives.

---

## 20. Scaling — where we'd go from here

Single-process today; FastChat-style scale-out documented in
[docs/architecture.md](architecture.md). The two cheapest wins:

1. **Cached leaderboard**: stop re-computing Elo on every `/pair` and
   `/leaderboard` request. Background job rebuilds Elo + bootstrap CI
   into a `leaderboard_snapshots` table every 30 s; reads become O(1).
2. **Durable job queue** for review generation: replace the in-process
   `void runPipeline(...)` with pg-boss / BullMQ. Workers pick up jobs,
   retry on failure, survive API restarts.

The architecture doc has a phased migration plan. None of it is needed
for Phase 4's ~100 votes, but the supervisor will likely ask "what
breaks at 1000 voters?" and that's the answer.

---

## 21. Spec coverage — what's done vs left

| Spec phase | Status | Notes |
|---|---|---|
| Phase 1 — Research & Design | ✅ | FastChat lift documented; LMArena referenced; literature on multi-agent reviewers (MARG, AI-Scientist, DeepReview, AgentReview) surveyed |
| Phase 2 — Platform Development | ✅ | Upload + parse + fan-out + 5 live systems; **TreeReview not integrated**, DeepReview registered-but-disabled (GPU) |
| Phase 3 — Leaderboard & Refinement | ✅ | Public leaderboard with CI; per-dimension sub-leaderboards; reveal screen wired with real ClaimChecks + radar |
| Phase 4 — User Study & Data Collection | 🟡 | Platform ready; operational steps (deploy, recruit, ~100 votes, qualitative feedback) not yet executed |
| Phase 5 — Analysis & Thesis Writing | ✅ pipeline | `thesis_eval.py` produces the four artefacts; running it on real data is gated on Phase 4 |

**The 4 spec mockup screens (Home/Leaderboard, Upload, Comparison,
Reveal)** — all four implemented and match the ASCII mockups.

**The two spec research questions** — both answerable with the data the
system collects.

---

## 22. Known limitations / honest answers to obvious questions

- **"Why not TreeReview?"** Single Python adapter file + seed row. ~150
  LOC. Skipped because we focused on getting the loop right with the 5
  live systems; trivial to add when needed.
- **"Why no DeepReview live runs?"** Needs a GPU host. The adapter is
  the stub the spec acknowledges. Flip `enabled=true` in the seed when
  GPU is available.
- **"Why 8 dimensions, not the proposal's 3 or the mockup's 5?"** The
  May 2026 thesis mockup shows 8. We took the most recent source. README
  documents.
- **"Why Express not Fastify?"** Fastify silently dropped Set-Cookie from
  `onRequest`; verified across multiple cookie plugins. Express +
  cookie-parser worked first try. The spec invited the call.
- **"Why Drizzle not Prisma?"** Drizzle's TS inference is fully
  schema-driven, no codegen step. Same Postgres schema either way.
- **"What if the same PDF is uploaded twice?"** `contentHash` (SHA-256)
  is unique. Current policy is **always re-run** — discard the new file,
  wipe prior reviews + votes for that paper, re-fan-out. You chose this
  during dev; documented in `papers.ts`.
- **"What about prompt injection?"** Adapters run in their own Python
  process; the JSON output schema is enforced by Pydantic; the judge's
  output schema is also Pydantic-validated. The reviewed PDF can attempt
  injection but can only cause a `FAILED` review row, not corrupt data.
- **"Why HMAC for pair tokens instead of a session table?"** Stateless.
  No server-side pair-store to keep consistent; the token IS the state.
  Verified with constant-time comparison.

---

## 23. The one-line summary if you only have 30 seconds

> ReviewArena is a FastChat-style blind pairwise benchmark for automated
> peer-review systems. Five systems live, 8 voting dimensions, Elo with
> 95% bootstrap CI per dimension, LLM-as-judge auto-scoring with
> paper-grounded claim verification on the reveal screen. The platform
> produces the four CSVs the analysis chapter needs to answer
> human-vs-metric correlation and per-dimension ranking questions.
