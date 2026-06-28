"""LLM-as-judge utilities used by the metrics + paper-grounded reveal pipeline.

API-based. Dispatches on model name:
  - "gemini-*"  →  Google GenAI (requires GEMINI_API_KEY).
  - everything else  →  OpenAI Chat Completions (requires OPENAI_API_KEY).

If the relevant key is missing the call raises loudly — there's no mock
fallback. The judge runs in the background per review (see
scoreOneReview), so a silent fake would pollute the leaderboard with
nonsense; better to fail and surface a config error.

Methodology references:
  - Zheng et al. 2023 (MT-Bench, arXiv:2306.05685) — reference-guided
    single-answer grading is our base paradigm.
  - Liu et al. 2023 (G-Eval, arXiv:2303.16634) — CoT + form-filling
    paradigm; the reasoning_per_dimension field below implements this.
  - Self-consistency: we run the judge JUDGE_PASSES times and average
    scores to reduce per-call stochasticity (model isn't perfectly
    deterministic even at temperature=0).
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

logger = logging.getLogger("review-gen.judge")

# Number of judge calls to average per review. 2 catches most outlier
# scores at ~2x the cost; higher N has diminishing returns. Even at
# temperature=0 the model can return scores ±0.5 across calls.
JUDGE_PASSES = 2

# Retry tuning for transient OpenAI errors (rate limits, timeouts,
# malformed JSON). Matches FastChat's pattern at lower scale: 5 attempts
# with exponential backoff = max ~30s wait before giving up.
JUDGE_RETRY_MAX = 5
JUDGE_RETRY_BASE_SEC = 1.0


class ClaimVerdict(BaseModel):
    claim: str
    verdict: Literal["SUPPORTED", "CONTRADICTED", "UNSUPPORTED"]
    evidence: str | None
    judge_model: str


@dataclass
class JudgeResult:
    """Bundle returned by the judge for a single review."""

    overall_score: float            # 1-10
    verifiability_score: float       # fraction of SUPPORTED claims
    dimension_scores: dict[str, float]
    claim_verdicts: list[ClaimVerdict]


_DIMENSIONS = (
    "COMPREHENSIVENESS",
    "CLARITY",
    "FAIRNESS",
    "ACTIONABILITY",
    "CONSTRUCTIVENESS",
    "OBJECTIVITY",
    "RELEVANCE",
    "TECHNICAL_TERMS",
)


def _build_prompts(paper_text: str, review_text: str) -> tuple[str, str]:
    """System + user prompt for one judge pass. Pure function so both the
    single-pass call and the multi-pass loop produce byte-identical
    inputs to the model (matters for prompt-caching hit rate)."""
    system_prompt = (
        "You are a strict meta-reviewer evaluating an automated peer review. "
        "Given the original paper text and a candidate review, return a JSON "
        "object with this exact shape:\n"
        "{\n"
        '  "reasoning_per_dimension": {DIM: str (1-2 sentences explaining the score) for DIM in ['
        f'{",".join(repr(d) for d in _DIMENSIONS)}'
        "]},\n"
        '  "dimension_scores": {DIM: float in [1,10] for DIM in ['
        f'{",".join(repr(d) for d in _DIMENSIONS)}'
        "]},\n"
        '  "overall_score": float in [1,10],\n'
        '  "claims": [\n'
        '    {"claim": str, "verdict": "SUPPORTED"|"CONTRADICTED"|"UNSUPPORTED", "evidence": str|null}\n'
        "  ]\n"
        "}\n\n"
        "Methodology — follow in order:\n"
        "1. For each dimension, write 1-2 sentences of reasoning grounded in "
        "specific parts of the review and paper. This goes in "
        "`reasoning_per_dimension`. (Chain-of-thought before scoring, "
        "per Liu et al. 2023 G-Eval, improves score calibration.)\n"
        "2. Then assign each dimension a 1-10 score consistent with your "
        "reasoning. 1=very poor, 5=adequate, 8=strong, 10=exemplary.\n"
        "3. Set `overall_score` as a holistic 1-10 judgment of the review's "
        "value to a paper author (NOT a mean of the dimensions).\n"
        "4. Extract every factual claim the review makes about the paper "
        "(5-15 typically) and verdict each against the paper text. "
        "Evidence should cite a section or quote when SUPPORTED/"
        "CONTRADICTED, else null.\n"
        "5. Do NOT reward verbose or padded reviews. Length without "
        "substance should LOWER the COMPREHENSIVENESS and CLARITY scores."
    )
    user_prompt = (
        f"=== PAPER ===\n{paper_text[:12000]}\n\n"
        f"=== REVIEW ===\n{review_text[:6000]}\n"
    )
    return system_prompt, user_prompt


def _is_gemini(model: str) -> bool:
    return model.lower().startswith("gemini")


def _openai_judge_pass(
    client,
    *,
    system_prompt: str,
    user_prompt: str,
    model: str,
) -> dict:
    response = client.chat.completions.create(
        model=model,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    raw = response.choices[0].message.content or "{}"
    return json.loads(raw)


def _gemini_judge_pass(
    *,
    system_prompt: str,
    user_prompt: str,
    model: str,
) -> dict:
    """One Gemini judge call. Uses google.generativeai with
    response_mime_type=application/json so the model returns parseable
    JSON without a code fence."""
    import google.generativeai as genai  # type: ignore[import-not-found]

    # generativeai is module-global by design — `configure()` sets the
    # API key for the process. Repeated calls are cheap and idempotent.
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    gm = genai.GenerativeModel(
        model_name=model,
        system_instruction=system_prompt,
    )
    response = gm.generate_content(
        user_prompt,
        generation_config={
            "temperature": 0,
            "response_mime_type": "application/json",
        },
    )
    raw = (response.text or "{}").strip()
    return json.loads(raw)


def _one_judge_pass(
    client,
    *,
    system_prompt: str,
    user_prompt: str,
    model: str,
) -> dict:
    """Single judge call with retry on transient errors. Dispatches by
    model name. Returns the parsed JSON dict. Raises RuntimeError if all
    retries fail. `client` is the OpenAI client (unused for Gemini)."""
    last_err: Exception | None = None
    for attempt in range(JUDGE_RETRY_MAX):
        try:
            if _is_gemini(model):
                return _gemini_judge_pass(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    model=model,
                )
            return _openai_judge_pass(
                client,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                model=model,
            )
        except Exception as e:  # noqa: BLE001 — retry on anything transient-looking
            last_err = e
            if attempt < JUDGE_RETRY_MAX - 1:
                # Exponential backoff: 1s, 2s, 4s, 8s. Caps total wait
                # at ~15s before raising.
                sleep_s = JUDGE_RETRY_BASE_SEC * (2 ** attempt)
                logger.warning(
                    "judge call failed (attempt %d/%d): %s — sleeping %.1fs",
                    attempt + 1, JUDGE_RETRY_MAX, e, sleep_s,
                )
                time.sleep(sleep_s)
    raise RuntimeError(f"judge call failed after {JUDGE_RETRY_MAX} attempts: {last_err}")


# Default judge model. Gemini 3.1 Pro is the top-tier Google model and
# is independent from any of our currently-deployed reviewer systems
# (we don't ship a Gemini reviewer that uses gemini-3.1-pro-preview as
# its underlying model directly in production — kept separate to avoid
# obvious self-grading bias).
DEFAULT_JUDGE_MODEL = "gemini-3.1-pro-preview"


def judge_review(
    review_text: str,
    paper_text: str,
    *,
    model: str = DEFAULT_JUDGE_MODEL,
) -> JudgeResult:
    """Score a review against the paper.

    Returns overall + per-dimension scores plus claim-level verdicts for
    the paper-grounded reveal screen. Raises RuntimeError if the
    relevant API key (GEMINI_API_KEY for gemini-*, OPENAI_API_KEY
    otherwise) is missing — no fake-data fallback.

    Runs the judge JUDGE_PASSES times and averages numeric scores to
    reduce stochasticity (even at temperature=0 the model is not
    perfectly deterministic, ~±0.5 variance observed). Claim verdicts
    are taken from the first pass — they're qualitative and majority
    voting across passes would require extra alignment logic.
    """
    using_gemini = _is_gemini(model)
    if using_gemini:
        if not os.environ.get("GEMINI_API_KEY"):
            raise RuntimeError(
                f"judge_review with model={model!r} requires GEMINI_API_KEY "
                "in the environment. There is no mock fallback."
            )
        client = None  # not used on the Gemini path
    else:
        if not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError(
                f"judge_review with model={model!r} requires OPENAI_API_KEY "
                "in the environment. There is no mock fallback."
            )
        from openai import OpenAI  # type: ignore[import-not-found]
        client = OpenAI()

    system_prompt, user_prompt = _build_prompts(paper_text, review_text)

    # Multi-pass averaging. If all passes fail we surface the error;
    # if some succeed we average over successes (still informative).
    pass_data: list[dict] = []
    for pass_idx in range(JUDGE_PASSES):
        try:
            pass_data.append(_one_judge_pass(
                client,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                model=model,
            ))
        except RuntimeError as e:
            logger.warning("judge pass %d/%d failed: %s", pass_idx + 1, JUDGE_PASSES, e)
    if not pass_data:
        raise RuntimeError(f"all {JUDGE_PASSES} judge passes failed")

    # Take claim verdicts from the first successful pass (claims are
    # qualitative — averaging doesn't apply; we'd need alignment).
    first = pass_data[0]
    verdicts = [
        ClaimVerdict(
            claim=c["claim"],
            verdict=c["verdict"],
            evidence=c.get("evidence"),
            judge_model=model,
        )
        for c in first.get("claims", [])
    ]
    supported = sum(1 for v in verdicts if v.verdict == "SUPPORTED")
    verifiability = (supported / len(verdicts)) if verdicts else 0.0

    # Average numeric scores across successful passes.
    def _avg(values: list[float]) -> float:
        return sum(values) / len(values) if values else 5.0

    overall = _avg([float(d.get("overall_score", 5)) for d in pass_data])
    dimension_scores: dict[str, float] = {}
    for dim in _DIMENSIONS:
        dimension_scores[dim] = _avg([
            float(d.get("dimension_scores", {}).get(dim, 5))
            for d in pass_data
        ])

    return JudgeResult(
        overall_score=overall,
        verifiability_score=verifiability,
        dimension_scores=dimension_scores,
        claim_verdicts=verdicts,
    )
