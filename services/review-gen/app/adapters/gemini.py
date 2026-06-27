"""Gemini prompting baseline.

Requires GEMINI_API_KEY in the environment. Emits the same ICLR-style
markdown the specialist adapters produce, so every system goes through
parse_markdown_review and the comparison UI never branches on adapter.
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


class GeminiAdapter(Adapter):
    adapter_key = "gemini"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GeminiAdapter requires GEMINI_API_KEY. "
                "Use the mock adapter for offline development."
            )
        # Lazy import — only loaded when this adapter is actually used.
        import google.generativeai as genai  # type: ignore[import-not-found]

        genai.configure(api_key=api_key)
        self._model_name = self.config.get("model", "gemini-1.5-flash")
        self._model = genai.GenerativeModel(
            model_name=self._model_name,
            system_instruction=_SYSTEM_PROMPT,
        )
        self._generation_config = {
            "temperature": self.config.get("temperature", 0.4),
            # Equalized output cap (FAIRNESS A1/A4).
            "max_output_tokens": FAIR_OUTPUT_TOKENS,
        }
        self._context_window = int(self.config.get("context_window", 1_000_000))

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
        response = self._model.generate_content(
            prompt,
            generation_config=self._generation_config,
        )
        raw = response.text or ""
        review = parse_markdown_review(raw, scale=ScoreScale.ICLR)
        return GenerationResult(review=review, raw_output=raw, metrics=self._metrics(prompt, raw))

    def generate_stream(
        self,
        paper: ParsedPaper,
        *,
        pdf_bytes: bytes | None = None,
    ) -> Iterator[StreamEvent]:
        """Gemini streaming via generate_content(stream=True). Emits ICLR
        markdown — same parse path as the specialists."""
        try:
            prompt = self._render_prompt(paper)
            if not prompt.strip():
                yield StreamEvent(type="error", error="Empty paper text")
                return
            chunks: list[str] = []
            for chunk in self._model.generate_content(
                prompt,
                generation_config=self._generation_config,
                stream=True,
            ):
                delta = getattr(chunk, "text", "") or ""
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
