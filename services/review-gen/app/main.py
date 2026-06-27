"""FastAPI entry point for the review-generation microservice.

Endpoints:
  POST /parse           — PDF → ParsedPaper via Datalab's hosted Chandra API
  POST /parse-arxiv     — arXiv ID/URL → ParsedPaper via arxiv2md
  POST /generate        — produce a structured review
  POST /stream-generate — streaming variant: yields tokens then 'done'
  POST /judge           — LLM-as-judge scoring + claim verdicts
  POST /metrics/bleu    — sentence BLEU vs a reference review
  POST /metrics/rouge   — ROUGE-1/2/L F-scores
  POST /analytics/topics       — topic model over a review corpus
  POST /analytics/wordfreq     — per-system word frequencies
  GET  /healthz
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

# Load the project-root .env BEFORE importing adapters, so OPENAI_API_KEY /
# GEMINI_API_KEY are available when the adapter registry first introspects them.
#
# Container path safety: in local dev, main.py lives at
# services/review-gen/app/main.py (4 levels deep from repo root, so
# parents[3] is the root). In Docker (Cloud Run), main.py lives at
# /app/app/main.py with only 2 parent levels, so parents[3] raises
# IndexError — and Cloud Run gets env vars from --set-env-vars /
# --set-secrets instead of a .env file. Tolerate both worlds.
from dotenv import load_dotenv

try:
    _ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"
    if _ROOT_ENV.is_file():
        load_dotenv(_ROOT_ENV)
except IndexError:
    # Containerised — no monorepo root; env comes from the platform.
    pass

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app import adapters
from app.adapters._budget import (
    FAIR_INPUT_TOKENS,
    count_tokens,
    render_canonical,
    render_canonical_scoped,
)
from app.judge import judge_review
from app.metrics import bleu, rouge
from app.analytics import topic_model, word_frequencies
from app.parsing import (
    Arxiv2MdError,
    ChandraError,
    parse_from_arxiv,
    parse_with_chandra,
)
from app.paper_render import render_paper_text
from app.schemas import (
    GenerateRequest,
    GenerateResponse,
    GenerationMetricsOut,
    ParsedPaper,
    ReviewScope,
)


def _attach_canonical(paper: ParsedPaper) -> ParsedPaper:
    """FAIRNESS A1: render the ONE canonical paper string once, at parse
    time, and stamp it on the ParsedPaper so every system is later handed
    the byte-identical text. Also records the full (untruncated) token
    count for fraction-of-paper-used accounting."""
    full_text = render_paper_text(paper, max_chars=10_000_000)  # effectively untruncated
    canonical = render_canonical(paper, max_input_tokens=FAIR_INPUT_TOKENS)
    paper.canonicalText = canonical
    paper.canonicalTokens = count_tokens(canonical)
    paper.fullTokens = count_tokens(full_text)
    return paper


def _apply_scope(paper: ParsedPaper, selected_section_ids: list[int] | None) -> ReviewScope | None:
    """If the caller picked a subset of sections, re-render canonicalText
    to include only those (full fidelity, with a [REVIEW SCOPE] notice)
    and return the matching ReviewScope. When None, leaves the paper as-is
    and returns None — adapters see the default full-paper canonical.

    The mutation is intentional: every adapter reads `paper.canonicalText`,
    so swapping it here makes the change transparent to them. The
    ReviewScope we return is stamped onto the StructuredReview by the
    caller so the persisted review carries provenance of what was shared.
    """
    if not selected_section_ids:
        return None
    canonical, scope = render_canonical_scoped(
        paper,
        selected_section_ids=selected_section_ids,
        max_input_tokens=FAIR_INPUT_TOKENS,
    )
    paper.canonicalText = canonical
    paper.canonicalTokens = scope.canonical_tokens
    return scope


def _metrics_out(metrics) -> GenerationMetricsOut | None:
    if metrics is None:
        return None
    return GenerationMetricsOut(
        input_tokens=metrics.input_tokens,
        output_tokens=metrics.output_tokens,
        context_window=metrics.context_window,
        fair_input_tokens=metrics.fair_input_tokens,
        fair_output_tokens=metrics.fair_output_tokens,
    )

logger = logging.getLogger("review-gen")
logging.basicConfig(level=logging.INFO)


# ─── Auth ─────────────────────────────────────────────────────────────────
# Every billable endpoint requires X-API-Key matching REVIEW_GEN_API_KEY.
# - Dev (REVIEWARENA_ENV != "production"): if the key is unset, we run
#   open and log a warning. Convenient for local hacking.
# - Prod (REVIEWARENA_ENV == "production"): missing key is a HARD FAILURE
#   at startup. Refusing to boot is much safer than silently accepting
#   unauthenticated traffic that drains the LLM budget.
_REVIEW_GEN_API_KEY = os.environ.get("REVIEW_GEN_API_KEY", "").strip()
_IS_PRODUCTION = os.environ.get("REVIEWARENA_ENV", "").strip().lower() == "production"

if not _REVIEW_GEN_API_KEY:
    if _IS_PRODUCTION:
        # Fail fast — uvicorn never finishes startup. Cloud Run will
        # surface this in the revision logs immediately.
        raise RuntimeError(
            "REVIEW_GEN_API_KEY is required in production "
            "(REVIEWARENA_ENV=production). "
            "Refusing to boot — would otherwise serve unauthenticated "
            "requests that bill OpenAI / Anthropic / Datalab / Modal."
        )
    logger.warning(
        "REVIEW_GEN_API_KEY not set — running in OPEN mode (dev). "
        "Any caller can trigger billable LLM endpoints. "
        "Set REVIEW_GEN_API_KEY in env (and REVIEWARENA_ENV=production) "
        "before deploying."
    )


def verify_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """FastAPI dependency: rejects requests without a valid X-API-Key.
    No-op when REVIEW_GEN_API_KEY is unset (dev mode only — prod refuses
    to boot in that state, see above)."""
    if not _REVIEW_GEN_API_KEY:
        return  # open mode — dev only; prod is gated at startup
    if not x_api_key or x_api_key != _REVIEW_GEN_API_KEY:
        raise HTTPException(status_code=401, detail="invalid or missing X-API-Key")


app = FastAPI(title="ReviewArena · review-gen", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, object]:
    # No auth — used by load balancers, monitoring, smoke tests.
    return {"ok": True, "adapters": adapters.known_keys()}


# ─── /parse ────────────────────────────────────────────────────────────────


@app.post("/parse", response_model=ParsedPaper, dependencies=[Depends(verify_api_key)])
async def parse(file: UploadFile = File(...)) -> ParsedPaper:
    """Parse a PDF via Datalab's hosted Chandra API and return the
    canonical ParsedPaper.

    Failure modes:
      - 502 if Datalab is unreachable, times out, or returns no usable
        markdown. The Node API marks the paper PARSE_FAILED so the user
        knows their upload didn't process.

    Implementation note: parse_with_chandra uses a synchronous httpx
    client and polls Datalab for up to ~5 minutes. We offload it to a
    worker thread so the event loop stays free for other requests.
    """
    if file.content_type not in (None, "application/pdf", "application/octet-stream"):
        raise HTTPException(status_code=415, detail=f"unsupported type {file.content_type}")
    pdf_bytes = await file.read()
    filename = file.filename or "paper.pdf"
    try:
        paper = await run_in_threadpool(parse_with_chandra, pdf_bytes, filename)
        return _attach_canonical(paper)
    except ChandraError as e:
        logger.warning("Chandra parse failed: %s", e)
        raise HTTPException(status_code=502, detail=str(e)) from e


# ─── /parse-arxiv ──────────────────────────────────────────────────────────


class ParseArxivRequest(BaseModel):
    url: str  # arXiv URL or bare ID; normalized server-side


@app.post("/parse-arxiv", response_model=ParsedPaper, dependencies=[Depends(verify_api_key)])
def parse_arxiv(req: ParseArxivRequest) -> ParsedPaper:
    """Parse an arXiv paper via timf34's hosted arxiv2md.org service.

    Failure modes:
      - 400 if the URL/ID is malformed.
      - 502 if arxiv2md.org is down, rate-limited, or returns no content
        (e.g. the paper has no HTML rendering on arXiv).
    """
    try:
        return _attach_canonical(parse_from_arxiv(req.url))
    except Arxiv2MdError as e:
        logger.warning("arxiv2md parse failed for %s: %s", req.url, e)
        raise HTTPException(status_code=502, detail=str(e)) from e


# ─── /generate ─────────────────────────────────────────────────────────────


_INSTANCE_CACHE: dict[tuple, adapters.Adapter] = {}


def _cache_key(adapter_key: str, config: dict) -> tuple:
    return (adapter_key, tuple(sorted(config.items())))


@app.post("/generate", response_model=GenerateResponse, dependencies=[Depends(verify_api_key)])
def generate(req: GenerateRequest) -> GenerateResponse:
    key = _cache_key(req.adapter_key, req.config)
    instance = _INSTANCE_CACHE.get(key)
    if instance is None:
        try:
            instance = adapters.get(req.adapter_key, req.config)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=str(e))
        _INSTANCE_CACHE[key] = instance

    # Decode PDF bytes only for adapters that asked for them.
    pdf_bytes: bytes | None = None
    if req.pdf_b64 and getattr(instance, "requires_pdf_bytes", False):
        import base64
        try:
            pdf_bytes = base64.b64decode(req.pdf_b64)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"bad pdf_b64: {e}") from e

    # Apply user-selected section scope, if any. This mutates the
    # paper's canonicalText so adapters (which read it verbatim) see
    # only the chosen sections + a [REVIEW SCOPE] notice.
    scope = _apply_scope(req.paper, req.selected_section_ids)

    start = time.perf_counter()
    try:
        result = instance.generate(req.paper, pdf_bytes=pdf_bytes)
    except Exception as e:
        logger.exception("adapter %s failed", req.adapter_key)
        raise HTTPException(status_code=502, detail=f"adapter failure: {e}") from e
    elapsed_ms = int((time.perf_counter() - start) * 1000)

    if scope is not None and result.review is not None:
        result.review.review_scope = scope

    return GenerateResponse(
        review=result.review,
        raw_output=result.raw_output,
        generation_ms=elapsed_ms,
        adapter_key=req.adapter_key,
        metrics=_metrics_out(result.metrics),
    )


# ─── /stream-generate ──────────────────────────────────────────────────────


@app.post("/stream-generate", dependencies=[Depends(verify_api_key)])
async def stream_generate(req: GenerateRequest, request: Request):
    """Server-Sent Events variant of /generate.

    Yields per-token deltas so the Node API can forward them to the
    browser. Same request shape as /generate; response is text/event-stream
    with events:
       event: token   data: {"text": "<delta>"}
       event: done    data: {"review": {...}, "raw_output": "...", "generation_ms": N}
       event: error   data: {"message": "..."}

    Disconnect handling: the generator polls request.is_disconnected()
    between events so the model call stops as soon as the Node bridge
    (which is itself reacting to a browser close) drops its socket.
    Saves real GPU minutes on Modal-hosted adapters.
    """
    from fastapi.responses import StreamingResponse

    key = _cache_key(req.adapter_key, req.config)
    instance = _INSTANCE_CACHE.get(key)
    if instance is None:
        try:
            instance = adapters.get(req.adapter_key, req.config)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=str(e))
        _INSTANCE_CACHE[key] = instance

    pdf_bytes: bytes | None = None
    if req.pdf_b64 and getattr(instance, "requires_pdf_bytes", False):
        import base64
        try:
            pdf_bytes = base64.b64decode(req.pdf_b64)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"bad pdf_b64: {e}") from e

    # Apply scope BEFORE the generator opens so the first token is
    # already keyed off the scoped canonical text.
    scope = _apply_scope(req.paper, req.selected_section_ids)

    async def event_source():
        import json as _json
        start = time.perf_counter()
        try:
            # Run the (synchronous) adapter generator in a worker thread
            # via an iterator hop so we can interleave is_disconnected()
            # checks on the asyncio loop. The hop is cheap — one
            # run_in_threadpool per emitted event.
            iterator = instance.generate_stream(req.paper, pdf_bytes=pdf_bytes)
            sentinel = object()

            def _next():
                try:
                    return next(iterator)
                except StopIteration:
                    return sentinel

            while True:
                if await request.is_disconnected():
                    logger.info(
                        "stream-generate aborted: client disconnected (%s)",
                        req.adapter_key,
                    )
                    return
                evt = await run_in_threadpool(_next)
                if evt is sentinel:
                    return
                if evt.type == "token":
                    payload = _json.dumps({"text": evt.text}, ensure_ascii=False)
                    yield f"event: token\ndata: {payload}\n\n"
                elif evt.type == "done":
                    elapsed_ms = int((time.perf_counter() - start) * 1000)
                    m = _metrics_out(evt.metrics)
                    # Stamp scope so the persisted review carries provenance.
                    if scope is not None and evt.result is not None:
                        evt.result.review_scope = scope
                    payload = _json.dumps(
                        {
                            "review": evt.result.model_dump() if evt.result else None,
                            "raw_output": evt.raw_output,
                            "generation_ms": elapsed_ms,
                            "adapter_key": req.adapter_key,
                            "metrics": m.model_dump() if m else None,
                        },
                        ensure_ascii=False,
                    )
                    yield f"event: done\ndata: {payload}\n\n"
                elif evt.type == "error":
                    payload = _json.dumps({"message": evt.error}, ensure_ascii=False)
                    yield f"event: error\ndata: {payload}\n\n"
        except Exception as e:  # noqa: BLE001
            logger.exception("stream-generate %s failed", req.adapter_key)
            payload = _json.dumps({"message": str(e)}, ensure_ascii=False)
            yield f"event: error\ndata: {payload}\n\n"

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            # Prevent intermediary buffering (proxies, nginx); SSE relies
            # on flushing every chunk.
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ─── /judge ────────────────────────────────────────────────────────────────


class JudgeRequest(BaseModel):
    review_text: str
    paper_text: str
    model: str = "gpt-4o-mini"


@app.post("/judge", dependencies=[Depends(verify_api_key)])
def judge(req: JudgeRequest) -> dict:
    result = judge_review(req.review_text, req.paper_text, model=req.model)
    return {
        "overall_score": result.overall_score,
        "verifiability_score": result.verifiability_score,
        "dimension_scores": result.dimension_scores,
        "claims": [v.model_dump() for v in result.claim_verdicts],
    }


# ─── /metrics ──────────────────────────────────────────────────────────────


class PairwiseTextRequest(BaseModel):
    candidate: str
    reference: str


@app.post("/metrics/bleu", dependencies=[Depends(verify_api_key)])
def metrics_bleu(req: PairwiseTextRequest) -> dict:
    try:
        return {"BLEU": bleu(req.candidate, req.reference)}
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.post("/metrics/rouge", dependencies=[Depends(verify_api_key)])
def metrics_rouge(req: PairwiseTextRequest) -> dict:
    try:
        return rouge(req.candidate, req.reference)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


# ─── /analytics ────────────────────────────────────────────────────────────


class AnalyticsRequest(BaseModel):
    reviews: list[str]
    n_topics: int = 8
    top_k: int = 50


@app.post("/analytics/topics", dependencies=[Depends(verify_api_key)])
def analytics_topics(req: AnalyticsRequest) -> dict:
    try:
        return {"topics": topic_model(req.reviews, n_topics=req.n_topics)}
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.post("/analytics/wordfreq", dependencies=[Depends(verify_api_key)])
def analytics_wordfreq(req: AnalyticsRequest) -> dict:
    return {"frequencies": word_frequencies(req.reviews, top_k=req.top_k)}
