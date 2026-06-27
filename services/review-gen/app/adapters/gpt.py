"""GPT-4o-mini prompting baseline.

Requires OPENAI_API_KEY in the environment. Falls back to the mock adapter
(via a runtime exception caller can catch) if missing — we don't want to
silently degrade in production.
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


class GPTAdapter(Adapter):
    adapter_key = "gpt-4o-mini"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GPTAdapter requires OPENAI_API_KEY. "
                "Use the mock adapter for offline development."
            )
        # Lazy import so the rest of the service starts without the OpenAI
        # client installed.
        from openai import OpenAI  # type: ignore[import-not-found]

        self._client = OpenAI(api_key=api_key)
        self._model = self.config.get("model", "gpt-4o-mini")
        # GPT-5 reasoning models reject any temperature != 1; keep it optional
        # so the seed config can omit it for those models.
        self._temperature = self.config.get("temperature")  # may be None
        self._context_window = int(self.config.get("context_window", 128_000))

    def _kwargs(self, prompt: str, *, stream: bool) -> dict:
        # Reasoning models (GPT-5, o1) reject `max_tokens` and require
        # `max_completion_tokens`. Switched via the `use_max_completion_tokens`
        # flag on the system's DB config. We send it via `extra_body` rather
        # than as a typed kwarg so it works on OpenAI SDKs pre-1.45 (which
        # don't have a `max_completion_tokens` parameter in their signature).
        # Either way, the cap is enforced — the fairness contract holds.
        use_mct = bool(self.config.get("use_max_completion_tokens"))
        kwargs: dict = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "stream": stream,
        }
        if use_mct:
            kwargs["extra_body"] = {"max_completion_tokens": FAIR_OUTPUT_TOKENS}
        else:
            kwargs["max_tokens"] = FAIR_OUTPUT_TOKENS
        if self._temperature is not None:
            kwargs["temperature"] = self._temperature
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
        response = self._client.chat.completions.create(**self._kwargs(prompt, stream=False))
        raw = response.choices[0].message.content or ""
        # Unified ICLR markdown — same parser path as DeepReviewer/OpenReviewer.
        # ScoreScale.ICLR rescales the 1-4 dimension scores back to the 1-10
        # ranges that StructuredReview persists.
        review = parse_markdown_review(raw, scale=ScoreScale.ICLR)
        return GenerationResult(review=review, raw_output=raw, metrics=self._metrics(prompt, raw))

    def generate_stream(
        self,
        paper: ParsedPaper,
        *,
        pdf_bytes: bytes | None = None,
    ) -> Iterator[StreamEvent]:
        """OpenAI streaming. The token stream is the literal markdown the
        browser will render — same format as the specialist adapters, so
        the comparison UI doesn't need to branch on parser type."""
        try:
            prompt = self._render_prompt(paper)
            if not prompt.strip():
                yield StreamEvent(type="error", error="Empty paper text")
                return
            chunks: list[str] = []
            for event in self._client.chat.completions.create(**self._kwargs(prompt, stream=True)):
                if not event.choices:
                    continue
                delta = event.choices[0].delta.content or ""
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
