"""DeepSeek V3.2 reviewer (deepseek-chat).

Native DeepSeek API access via DeepSeek's OpenAI-compatible endpoint.
We use the openai SDK pointed at https://api.deepseek.com/v1 — the
DeepSeek docs explicitly recommend this and their schema matches.

A dedicated adapter (vs reusing openai_compat with config) gives the
thesis a clean 1:1 mapping between review_systems rows and adapter
source, and lets us add DeepSeek-specific behaviour later without
touching the shared generic adapter:
  - cache-hit pricing (DeepSeek bills cached prefix tokens at a steep
    discount; logging both separately matters for the cost chapter)
  - reasoning-mode support when we switch to deepseek-reasoner
  - any future API quirks specific to DeepSeek

Requires DEEPSEEK_API_KEY in the environment. Falls back loudly if
missing — no silent mock so a stale leaderboard doesn't accumulate
fake votes against missing data.
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

_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"

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


class DeepSeekAdapter(Adapter):
    adapter_key = "deepseek-v3-2"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        api_key = os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            raise RuntimeError(
                "DeepSeekAdapter requires DEEPSEEK_API_KEY. "
                "Get one at https://platform.deepseek.com/ and add it to .env."
            )
        # Lazy import so the rest of the service starts without the
        # openai SDK installed.
        from openai import OpenAI  # type: ignore[import-not-found]

        # DeepSeek exposes an OpenAI-compatible endpoint at api.deepseek.com/v1.
        # Same chat-completions schema, same auth shape — we just point the
        # client at their base URL instead of OpenAI's.
        self._client = OpenAI(api_key=api_key, base_url=_DEEPSEEK_BASE_URL)
        self._model = self.config.get("model", "deepseek-chat")
        self._temperature = self.config.get("temperature", 0.2)
        # DeepSeek V3.2 has a 128k context window per their docs.
        self._context_window = int(self.config.get("context_window", 128_000))

    def _kwargs(self, prompt: str, *, stream: bool) -> dict:
        return {
            "model": self._model,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": FAIR_OUTPUT_TOKENS,
            "temperature": self._temperature,
            "stream": stream,
        }

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
        review = parse_markdown_review(raw, scale=ScoreScale.ICLR)
        return GenerationResult(review=review, raw_output=raw, metrics=self._metrics(prompt, raw))

    def generate_stream(
        self,
        paper: ParsedPaper,
        *,
        pdf_bytes: bytes | None = None,
    ) -> Iterator[StreamEvent]:
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
