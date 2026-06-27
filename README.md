# ReviewArena

A web platform for benchmarking automated peer review systems through human
pairwise comparison and Elo ranking.

**Master thesis project — Ubiquitous Knowledge Processing Lab (UKP),
TU Darmstadt.**

---

## What it does

1. You upload a research paper (PDF or arXiv URL).
2. ReviewArena parses it via **Marker** (Modal-hosted, GPU-backed PDF →
   markdown) and picks two automated reviewers from the enabled pool
   using LMArena's weighted, Elo-aware pair-selection algorithm.
3. The two reviews stream live into side-by-side panels (server-sent
   events, token-by-token).
4. You vote which review is more useful, or call it a tie. Optionally,
   refine across eight dimensions: Comprehensiveness, Clarity, Fairness,
   Actionability, Constructiveness, Objectivity, Relevance,
   Technical Terms.
5. Votes update an overall and per-dimension Elo ranking with
   bootstrapped 95% CIs (verbatim FastChat port).
6. The reveal screen shows which system produced A and B, the Elo
   before/after, a radar of LLM-judge dimension scores, and a
   paper-grounded claim check (each review claim labelled
   **Supported / Contradicted / Unsupported** against the paper text).

## Live review systems

| Slug              | Backing model                    | Hosting                    | Streams?     |
|-------------------|----------------------------------|----------------------------|--------------|
| `gpt-5-mini`      | OpenAI GPT-4o-mini (chat)        | OpenAI API                 | yes (SDK)    |
| `gemini-2.5-flash`| Google Gemini 2.5 Flash          | Google AI Studio API       | yes (SDK)    |
| `deepreviewer-7b` | WestlakeNLP/DeepReviewer-7B      | Modal (vLLM, L4 GPU)       | yes (vLLM)   |
| `openreviewer-8b` | maxidl/Llama-OpenReviewer-8B     | Modal (vLLM, L4 GPU)       | yes (vLLM)   |

Mock adapter exists for local-only dev.

## Architecture

```
 ┌──────────────┐       ┌──────────────┐       ┌──────────────────────┐
 │  React/Vite  │──HTTP─│   Express    │──HTTP─│      FastAPI         │
 │  (apps/web)  │       │  (apps/api)  │       │ (services/review-gen)│
 └──────────────┘       └──────┬───────┘       └──────────┬───────────┘
                               │                          │
                        ┌──────▼───────┐         ┌────────▼──────────┐
                        │   Postgres   │         │  Adapters         │
                        │  (Drizzle)   │         │  (mock / gpt /    │
                        └──────────────┘         │   gemini /        │
                                                 │   deepreviewer /  │
                                                 │   openreviewer)   │
                                                 └────────┬──────────┘
                                                          │
                            ┌─────────────────────────────┼────────────────────────┐
                            │                             │                        │
                    ┌───────▼────────┐         ┌──────────▼─────────┐    ┌─────────▼──────────┐
                    │ Marker (Modal) │         │ DeepReviewer-7B    │    │ OpenReviewer-8B    │
                    │ PDF → markdown │         │ (Modal vLLM L4)    │    │ (Modal vLLM L4)    │
                    └────────────────┘         └────────────────────┘    └────────────────────┘
```

All GPU work runs on **Modal** scale-to-zero containers. Local dev only
needs Postgres (in Docker) — the four review adapters call hosted APIs.

## Monorepo layout

```
reviewarena/
├── apps/
│   ├── web/                       # Vite + React + TS + Tailwind + shadcn/ui
│   │   └── src/{pages,components,lib}
│   └── api/                       # Express + TS + Drizzle (Postgres)
│       ├── drizzle.config.ts
│       ├── drizzle/               # SQL migrations
│       ├── scripts/               # CLI utilities: seed.ts, drop-all.ts, inspect.ts, …
│       └── src/
│           ├── db/                # schema.ts, client.ts
│           ├── clients/           # review-gen-client.ts, judge-client.ts
│           ├── pipeline/          # orchestrator.ts, score-paper.ts
│           ├── elo/               # FastChat-port Elo + bootstrap CI (+ tests)
│           ├── pair/              # LMArena pair selector (+ tests)
│           ├── routes/            # papers, pair, votes, leaderboard, reveal, admin
│           ├── plugins/           # session cookie, admin bearer auth
│           └── server.ts
├── services/
│   ├── review-gen/                # FastAPI; /parse, /generate, /stream-generate, /judge
│   │   └── app/adapters/{mock,gpt,gemini,deepreviewer_real,openreviewer}.py
│   ├── deepreviewer-modal/        # WestlakeNLP/DeepReviewer-7B via vLLM on Modal
│   └── openreviewer-modal/        # maxidl/Llama-OpenReviewer-8B via vLLM on Modal
# PDF parsing: review-gen/app/parsing/chandra.py → Datalab's hosted Chandra API
├── packages/
│   └── shared-types/              # Zod schemas + TS types
├── scripts/
│   └── thesis_eval.py             # consumes /admin/export.json → CSVs + plots
├── docs/
│   ├── architecture.md
│   ├── walkthrough.md
│   └── SECRETS.md                 # rotation playbook
├── docker-compose.yml             # Postgres only
├── mprocs.yaml                    # local dev runner
├── pnpm-workspace.yaml
└── package.json
```

## Tech stack — key choices

| Layer            | Choice                                     | Why                                                                                                                       |
|------------------|--------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|
| Frontend         | React + Vite + TS, Tailwind, shadcn/ui     | As specified.                                                                                                             |
| Data fetching    | TanStack Query                             | As specified. No Redux.                                                                                                   |
| Backend          | **Express 4** (originally Fastify)         | Fastify silently swallowed Set-Cookie headers from `onRequest` hooks; Express + cookie-parser + multer + Zod was simpler. |
| ORM              | **Drizzle** (originally Prisma)            | TS inference from the schema file, no codegen step.                                                                       |
| Streaming        | Server-Sent Events (browser → API → Python → vLLM) | Survives Modal's ~150s sync-HTTP gateway timeout end-to-end.                                                               |
| Review-gen       | Python FastAPI microservice                | Adapter SDKs (OpenAI, Gemini, httpx for Modal) + Pydantic schemas all Python-native.                                      |
| PDF parsing      | **Marker on Modal** (was GROBID)           | Marker preserves LaTeX equations + reconstructs markdown tables; GROBID's TEI XML lost both. Modal scale-to-zero GPU.     |
| GPU adapters     | **Modal serverless** (was self-hosted)     | L4 GPUs at ~$0.80/h with scale-to-zero; cold start mitigated by vLLM streaming + `--api-key` auth.                       |
| Tests            | Vitest                                     | Same runner both sides. Elo math + pair selection have the deepest coverage.                                              |
| Package manager  | pnpm workspaces                            | Strict by default; surfaces missing deps early.                                                                           |

## Quickstart

```bash
# 1. JS deps + Python deps
pnpm install
python3 -m venv services/review-gen/.venv
services/review-gen/.venv/bin/pip install -r services/review-gen/requirements.txt

# 2. Environment + database
cp .env.example .env
# then paste DATABASE_URL, ADMIN_TOKEN, PAIR_TOKEN_SECRET, WEB_ORIGIN,
# and (optionally) MARKER_URL/DEEPREVIEWER_URL/OPENREVIEWER_URL +
# their Modal deploys + MODAL_SHARED_SECRET. Generate the local secrets
# with `openssl rand -hex 32`. See docs/SECRETS.md for the rotation playbook.

pnpm --filter @reviewarena/api db:push     # apply Drizzle schema
pnpm --filter @reviewarena/api db:seed     # insert review systems

# 3. (One-time) Deploy the review-LLM Modal services + set the Datalab key
modal secret create modal-shared-auth MODAL_SHARED_SECRET="<your value from .env>"
modal secret create hf-token HF_TOKEN="<your HF read token>"
modal deploy services/deepreviewer-modal/deepreviewer_modal.py
modal deploy services/openreviewer-modal/openreviewer_modal.py
# Paste the printed URLs into .env (DEEPREVIEWER_URL, OPENREVIEWER_URL).
# Add CHANDRA_API_KEY from https://www.datalab.to (PDF parsing path).

# 4. Local Postgres (skip if using Neon or other managed)
docker compose up -d

# 5. Run everything
pnpm dev                           # starts postgres tail + review-gen :8001 + api :8000 + web :5173
```

Then open <http://localhost:5173>.

Without `OPENAI_API_KEY` / `GEMINI_API_KEY`, those adapters return 503
and the LLM-as-judge falls back to a deterministic mock.

### Environment variables

See [.env.example](.env.example). Required at minimum:

- `DATABASE_URL` — Postgres connection (Neon or local)
- `ADMIN_TOKEN` — bearer for `/admin/*` (32+ char random)
- `PAIR_TOKEN_SECRET` — HMAC key for pair tokens (32+ char random, **separate** from ADMIN_TOKEN)
- `WEB_ORIGIN` — CORS whitelist, comma-separated
- `MODAL_SHARED_SECRET` — auth for the three Modal services

For LLM/Modal adapters you also need `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`HF_TOKEN`, and the three Modal URLs.

Rotation playbook: [docs/SECRETS.md](docs/SECRETS.md).

## Deployment

The API + web are small Node processes (any small VM works — Fly,
Render, EC2). The expensive parts (PDF parsing, model inference) live
on Modal and scale to zero.

```bash
pnpm install --frozen-lockfile
pnpm --filter @reviewarena/api build
pnpm --filter @reviewarena/web build

# Apply migrations + custom one-shots
pnpm --filter @reviewarena/api exec drizzle-kit migrate
pnpm --filter @reviewarena/api exec tsx scripts/add-votes-replay-uk.ts
pnpm --filter @reviewarena/api exec tsx scripts/add-paper-uploaded-by-session.ts

# Run with a process supervisor (systemd / pm2 / nixpacks):
#   api:  node dist/server.js                     (port 8000)
#   web:  any static host serving apps/web/dist/  (Vite SPA)
#   review-gen: uvicorn app.main:app --host 0.0.0.0 --port 8001 --workers 2
#   modal:  always-on, scale to zero
```

A reverse proxy (Caddy / Nginx) typically routes `/api/*` to `:8000` and
serves the SPA for everything else.

**Backup**: nightly `pg_dump`. PDFs are never persisted — only the
parsed structure (jsonb) and review outputs are stored.

## Algorithmic credits

Elo update and bootstrap CI are ported verbatim from
[LMSYS FastChat](https://github.com/lm-sys/FastChat) (Apache 2.0); see
the file-level comment in [apps/api/src/elo/elo.ts](apps/api/src/elo/elo.ts).
Constants are FastChat's defaults (K=4, BASE=10, SCALE=400, INIT=1000).
The LMArena `get_battle_pair` weighted sampler is similarly ported to
[apps/api/src/pair/select-pair.ts](apps/api/src/pair/select-pair.ts).

LMArena's *current* public leaderboard uses Bradley-Terry MLE with
style control; we deliberately use online Elo + bootstrap CI because
thesis-scale (~250 votes) is below the data threshold where BT-MLE
converges cleanly.

## Status

- [x] **Checkpoint 1** — Monorepo, manifests, docker-compose, README
- [x] **Checkpoint 2** — Schema (Paper, ReviewSystem, Review, Vote,
       DimensionVote, EloSnapshot, MetricScore, ClaimCheck)
- [x] **Checkpoint 3** — Express routes + Elo module + Vitest cases
- [x] **Checkpoint 4** — Four frontend screens (Leaderboard, Upload,
       Comparison, Reveal)
- [x] **Checkpoint 5** — FastAPI review-gen + 4 live adapters
- [x] **Checkpoint 6** — Upload → parse → pair-select → generate →
       vote → Elo → snapshot → reveal, with SSE streaming end-to-end
- [x] **Checkpoint 7** — Paper-grounded ClaimCheck, BLEU/ROUGE/judge,
       BERTopic / word-frequency analytics
- [x] **Checkpoint 8** — Admin CRUD + CSV/JSON export, Modal deploys,
       [thesis evaluation script](scripts/thesis_eval.py)

## Testing

```bash
pnpm --filter @reviewarena/api test         # Elo math, pair selection, HMAC
pnpm --filter @reviewarena/api typecheck
pnpm --filter @reviewarena/web typecheck
```

## Decisions log

- **8 dimensions, not 5.** Spec listed 5; thesis mockup canonical at 8.
- **Prisma → Drizzle.** TS inference from schema beats codegen.
- **Express, not Fastify.** Set-Cookie dropped from `onRequest` hooks.
- **Marker, not GROBID.** Marker preserves equations + tables; GROBID's
  TEI XML lost both, on top of being a 6 GB Docker image.
- **LMArena pair selection** (was random) — Elo-aware weighted sample.
- **Pre-select 2, then generate** (was fan-out to all enabled systems)
  saves ~50% of GPU/API spend per paper.
- **SSE end-to-end streaming** — survives Modal's ~150s sync gateway.
- **DeepReviewer + OpenReviewer on Modal.** Both shipped as vLLM
  `@web_server` apps with `--api-key` auth; no self-hosted GPU.
- **Anonymous httpOnly session cookie.** No IP, fingerprint, or email.
- **`PAIR_TOKEN_SECRET` separate from `ADMIN_TOKEN`.** Leaking admin
  must not let an attacker forge pair tokens.
- **K = 4 (FastChat default).** Full-history replay; smaller K stops
  the most recent vote from dominating the rating.

## Thesis analysis workflow

```bash
export ADMIN_TOKEN=…
python scripts/thesis_eval.py --token "$ADMIN_TOKEN"
```

Output (in `research/analysis/`):
- `export.json` — raw dump
- `votes_long.csv` — one row per vote, dimension columns flattened
- `head_to_head.csv` — pairwise win/loss/tie counts
- `elo_trajectory.png` — per-system Elo over time, 95% CI shaded
- `human_vs_judge.csv` — winrate vs LLM-judge mean per system
