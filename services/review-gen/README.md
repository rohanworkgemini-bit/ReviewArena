# `review-gen` — FastAPI service

Python service that hosts the **review adapters**, the **PDF/arXiv
parsers**, and the **LLM-as-judge**. The Node API calls it over HTTP.

## Layout

```
app/
├── main.py              FastAPI app + endpoints
├── schemas.py           Pydantic mirrors of packages/shared-types
├── paper_render.py      Canonical paper→prompt rendering (FAIRNESS A1)
├── judge.py             LLM-as-judge: claim extraction + verification
├── metrics.py           BLEU / ROUGE (out of scope for thesis, kept)
├── analytics.py         Topic model + word freq (admin endpoints)
├── parsing/
│   ├── arxiv2md.py     arXiv URL/ID → ParsedPaper (timf34's hosted service)
│   └── chandra.py      PDF → ParsedPaper (Datalab hosted /convert API)
└── adapters/
    ├── base.py          Adapter abstract class + StreamEvent
    ├── _budget.py       Shared input budgeting (FAIRNESS A4)
    ├── _review_parse.py Shared markdown/JSON → StructuredReview
    ├── vllm_base.py     Base for any OpenAI-compatible vLLM model
    ├── mock.py          Deterministic offline fallback
    ├── gpt.py           OpenAI GPT-5-mini zero-shot
    ├── gemini.py        Google Gemini 2.5 Flash zero-shot
    ├── deepreviewer_real.py  → Modal vLLM (WestlakeNLP/DeepReviewer-7B)
    ├── openreviewer.py       → Modal vLLM (maxidl/Llama-OpenReviewer-8B)
    ├── cyclereviewer.py      → Modal vLLM (CycleReviewer-8B)
    ├── sea.py                → Modal vLLM (SEA-E)
    └── openai_compat.py      Generic OpenAI-compatible (DeepSeek, Claude/OpenRouter, GPT-4o)
```

## Endpoints

- `POST /parse` — PDF → ParsedPaper via Datalab Chandra
- `POST /parse-arxiv` — arxiv2md pipeline (URL/ID → ParsedPaper)
- `POST /generate` — non-streaming review (used by admin/re-score)
- `POST /stream-generate` — **SSE**: yields token / done / error events
- `POST /judge` — claim extraction + per-claim verdict
- `POST /metrics/{bleu,rouge}` — pairwise metrics
- `POST /analytics/{topics,wordfreq}` — corpus-level analytics
- `GET /healthz` — readiness probe

## Adapter integration recipe

To add a new vLLM-served model, create
`adapters/<slug>.py` extending `VLLMChatAdapter` (see its docstring
for required fields), register it in `adapters/__init__.py`, and
add a row to `review_systems` via `apps/api/scripts/seed.ts`.

## Dev

```bash
uvicorn app.main:app --reload --port 8001 --app-dir services/review-gen --reload-dir services/review-gen/app
```

Or just `mprocs` from the repo root — the `review-gen` proc handles this.
