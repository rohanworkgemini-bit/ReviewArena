"""Claude (Anthropic) zero-shot reviewer.

Native Anthropic SDK — cheaper and more reliable than going through
OpenRouter. Uses adaptive thinking (the Opus 4.8 default per Anthropic's
recommendations: thinking depth is auto-tuned per request).

Requires ANTHROPIC_API_KEY in the environment. Falls back loudly if
missing — we don't want to silently degrade on a billable model.

Methodology references:
  - claude-opus-4-8 is the current widely-released Opus tier (per
    Anthropic's claude-api skill, 2026-06+).
  - Adaptive thinking on Opus 4.6+ replaces the deprecated `budget_tokens`
    knob; effort=high is the default for intelligence-sensitive work.
  - We omit `thinking` entirely on models that don't support it (e.g. a
    user pointing this adapter at Sonnet 4.5 via config override).
"""
from __future__ import annotations

import os
from textwrap import dedent
from typing import Iterator

from app.adapters._budget import (
    FAIR_OUTPUT_TOKENS,
    count_tokens,
    render_canonical,
)
from app.adapters._review_parse import ScoreScale, parse_markdown_review
from app.adapters.base import Adapter, GenerationMetrics, GenerationResult, StreamEvent
from app.schemas import ParsedPaper

_SYSTEM_PROMPT = dedent("""
    You are an experienced peer reviewer for a top-tier ML/NLP conference
    (NeurIPS, ICLR, ACL). Read the paper below and write a structured peer
    review using markdown headers, in the EXACT order shown.

    For each numeric section (Soundness, Presentation, Contribution, Rating,
    Confidence), begin with a SINGLE INTEGER on its own line, then one
    brief sentence explaining the score.

    ## Summary
    (2-4 sentences describing what the paper does and your overall impression.)

    ## Soundness
    (Integer 1-4 — 1=poor, 2=fair, 3=good, 4=excellent. Methodology + logical
    consistency.)

    ## Presentation
    (Integer 1-4. Clarity, structure, writing quality.)

    ## Contribution
    (Integer 1-4. Novelty and significance.)

    ## Rating
    (Integer 1-10. 1=strong reject, 5=marginal, 8=accept, 10=strong accept.)

    ## Confidence
    (Integer 1-5. How confident you are in this assessment.)

    ## Strengths
    (Concise bullet list, 3-5 items.)

    ## Weaknesses
    (Concise bullet list, 3-6 items.)

    ## Questions
    (Concise bullet list of questions for the authors, 2-5 items.)

    The paper may be presented with a "[REVIEW SCOPE]" notice indicating
    that only certain sections are in scope. If so, restrict your review
    to those sections, do not speculate about omitted content, and do not
    penalize the paper for material not shown.

    Plain markdown only — no preamble, no JSON, no extra commentary.
""").strip()


class ClaudeAdapter(Adapter):
    adapter_key = "claude"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "ClaudeAdapter requires ANTHROPIC_API_KEY. "
                "Set it in .env or disable the claude-opus system."
            )
        # Lazy import so the rest of the service starts without the
        # anthropic SDK installed.
        from anthropic import Anthropic  # type: ignore[import-not-found]

        self._client = Anthropic(api_key=api_key)
        self._model = self.config.get("model", "claude-opus-4-8")
        # Opus 4.6+ supports adaptive thinking; pre-4.6 models don't.
        # Allow the seed to opt out via thinking=False if pointing at an
        # older model.
        self._thinking_enabled = bool(self.config.get("thinking", True))
        self._context_window = int(self.config.get("context_window", 200_000))

    def _kwargs(self, prompt: str, *, stream: bool) -> dict:
        # Anthropic's messages API: system is a top-level string, user
        # content is a single message. max_tokens is the per-response
        # cap (enforced); we keep it equal to our fairness output budget.
        kwargs: dict = {
            "model": self._model,
            "max_tokens": FAIR_OUTPUT_TOKENS,
            "system": _SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": prompt}],
        }
        if self._thinking_enabled:
            # Adaptive thinking: model auto-tunes reasoning depth.
            # Effort=high pairs well with peer review (multi-criterion
            # judgment) without burning tokens unnecessarily.
            kwargs["thinking"] = {"type": "adaptive"}
            kwargs["output_config"] = {"effort": "high"}
        return kwargs

    def _metrics(self, prompt: str, raw: str) -> GenerationMetrics:
        return GenerationMetrics(
            input_tokens=count_tokens(prompt),
            output_tokens=count_tokens(raw),
            context_window=self._context_window,
            fair_input_tokens=count_tokens(prompt),
            fair_output_tokens=FAIR_OUTPUT_TOKENS,
        )

    def generate(self, paper: ParsedPaper, *, pdf_bytes: bytes | None = None) -> GenerationResult:
        prompt = self._render_prompt(paper)
        if not prompt.strip():
            raise ValueError(
                "Empty paper content — refusing to call the model. "
                "The PDF probably contains no extractable text."
            )
        response = self._client.messages.create(**self._kwargs(prompt, stream=False))
        # Concatenate every text block; ignore thinking blocks (they're
        # for the model's internal reasoning, not the user-facing output).
        raw = "".join(
            block.text for block in response.content if getattr(block, "type", None) == "text"
        )
        # Unified ICLR markdown — same parser path as the other adapters.
        review = parse_markdown_review(raw, scale=ScoreScale.ICLR)
        return GenerationResult(review=review, raw_output=raw, metrics=self._metrics(prompt, raw))

    def generate_stream(
        self,
        paper: ParsedPaper,
        *,
        pdf_bytes: bytes | None = None,
    ) -> Iterator[StreamEvent]:
        """Anthropic streaming via the SDK helper. Emits per-token deltas
        as the model writes them; the browser renders markdown live."""
        try:
            prompt = self._render_prompt(paper)
            if not prompt.strip():
                yield StreamEvent(type="error", error="Empty paper text")
                return
            chunks: list[str] = []
            with self._client.messages.stream(**self._kwargs(prompt, stream=True)) as stream:
                for delta in stream.text_stream:
                    if delta:
                        chunks.append(delta)
                        yield StreamEvent(type="token", text=delta)
            raw = "".join(chunks).strip()
            review = parse_markdown_review(raw, scale=ScoreScale.ICLR)
            yield StreamEvent(
                type="done", result=review, raw_output=raw, metrics=self._metrics(prompt, raw)
            )
        except Exception as e:  # noqa: BLE001
            yield StreamEvent(type="error", error=str(e))

    def _render_prompt(self, paper: ParsedPaper) -> str:
        # FAIRNESS A1: identical canonical input across every system.
        return paper.canonicalText or render_canonical(paper)
