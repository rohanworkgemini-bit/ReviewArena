"""Base class for any OpenAI-compatible (vLLM-served) review model.

This is the standardized integration point. To add a new vLLM-served
reviewer, subclass and declare a handful of fields — you inherit input
budgeting, auth, streaming + non-streaming transport, cold-start (303)
handling, and markdown→StructuredReview parsing with score
normalization. The ONLY model-specific code you write is the prompt.

────────────────────────────────────────────────────────────────────────
Template for a future system:

    from app.adapters._review_parse import ScoreScale
    from app.adapters.vllm_base import VLLMChatAdapter

    _SYSTEM_PROMPT = "You are an expert reviewer ..."

    class MyReviewerAdapter(VLLMChatAdapter):
        adapter_key = "my-reviewer-13b"
        env_url_var = "MY_REVIEWER_URL"          # Modal URL in .env
        default_model = "org/MyReviewer-13B"
        context_window = 32_000                  # model max_model_len
        max_output_tokens = 3072                 # reserve for the review
        score_scale = ScoreScale.ICLR            # or TEN_POINT

        def build_messages(self, paper_text: str) -> list[dict]:
            return [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": f"Review:\\n\\n{paper_text}"},
            ]

Then register it in app/adapters/__init__.py and add a seed row whose
adapter_key matches. That's the whole integration.
────────────────────────────────────────────────────────────────────────
"""
from __future__ import annotations

import json
import os
from abc import abstractmethod
from typing import Iterator

import httpx

from app.adapters._budget import (
    FAIR_INPUT_TOKENS,
    FAIR_OUTPUT_TOKENS,
    count_tokens,
    render_canonical,
)
from app.adapters._review_parse import ScoreScale, parse_markdown_review
from app.adapters.base import Adapter, GenerationMetrics, GenerationResult, StreamEvent
from app.schemas import ParsedPaper, StructuredReview


class VLLMChatAdapter(Adapter):
    """Common transport + budgeting + parsing for vLLM chat models.

    Subclasses MUST set:
      adapter_key, env_url_var, default_model, context_window,
      max_output_tokens, score_scale
    and implement build_messages().
    """

    # ─── subclass-declared contract ────────────────────────────────────────
    env_url_var: str = "REVIEW_MODEL_URL"
    default_model: str = "unknown/model"
    context_window: int = 16_000
    max_output_tokens: int = 3072
    score_scale: ScoreScale = ScoreScale.ICLR

    # Shared sampling defaults. Subclasses override the class attrs or let
    # the per-system DB `config` override at runtime. repetition_penalty
    # is essential: at low temperatures these models loop on dense papers.
    default_temperature: float = 0.4
    default_top_p: float = 0.95
    default_repetition_penalty: float = 1.1
    default_frequency_penalty: float = 0.3

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        base = os.environ.get(self.env_url_var, "").rstrip("/")
        if not base:
            raise RuntimeError(
                f"{type(self).__name__} requires {self.env_url_var} in the "
                f"environment. Deploy the corresponding Modal service first."
            )
        self.url = base if "/v1/" in base else f"{base}/v1/chat/completions"

        self.model = self.config.get("model", self.default_model)
        self.temperature = float(self.config.get("temperature", self.default_temperature))
        self.top_p = float(self.config.get("top_p", self.default_top_p))
        self.repetition_penalty = float(
            self.config.get("repetition_penalty", self.default_repetition_penalty)
        )
        self.frequency_penalty = float(
            self.config.get("frequency_penalty", self.default_frequency_penalty)
        )
        self.max_tokens = int(self.config.get("max_tokens", self.max_output_tokens))
        self.timeout_s = float(self.config.get("timeout_s", 600))

        # Shared-secret auth: vLLM's --api-key flag rejects requests without
        # Authorization: Bearer <key>. Same value as the modal-shared-auth
        # secret on the server side.
        self._modal_secret = os.environ.get("MODAL_SHARED_SECRET", "").strip()

    # ─── subclass implements ONLY this ─────────────────────────────────────

    @abstractmethod
    def build_messages(self, paper_text: str) -> list[dict]:
        """Return the OpenAI `messages` list for this model. The paper has
        already been rendered + truncated to the model's input budget."""

    # ─── shared machinery ──────────────────────────────────────────────────

    def _auth_headers(self) -> dict:
        return (
            {"Authorization": f"Bearer {self._modal_secret}"}
            if self._modal_secret
            else {}
        )

    def _canonical_text(self, paper: ParsedPaper) -> str:
        """The byte-identical input handed to every system (FAIRNESS A1).

        Uses the canonical text rendered once at parse time when present
        (so it is provably identical across systems); otherwise renders it
        here to the SAME fair budget — deterministic, so still identical."""
        if paper.canonicalText:
            return paper.canonicalText
        return render_canonical(paper)

    def _payload(self, paper_text: str) -> dict:
        if not paper_text.strip():
            raise ValueError(
                f"Empty paper text; refusing to call {self.model}. "
                "The PDF probably contains no extractable text."
            )
        return {
            "model": self.model,
            "messages": self.build_messages(paper_text),
            "temperature": self.temperature,
            "top_p": self.top_p,
            "repetition_penalty": self.repetition_penalty,
            "frequency_penalty": self.frequency_penalty,
            # Equalized output budget — identical cap for every system so
            # verbosity allowance is not a confound (FAIRNESS A1/A4).
            "max_tokens": FAIR_OUTPUT_TOKENS,
            "stream": True,
        }

    def _metrics(self, input_text: str, output_text: str) -> GenerationMetrics:
        return GenerationMetrics(
            input_tokens=count_tokens(input_text),
            output_tokens=count_tokens(output_text),
            context_window=self.context_window,
            fair_input_tokens=FAIR_INPUT_TOKENS,
            fair_output_tokens=FAIR_OUTPUT_TOKENS,
        )

    def _parse(self, markdown: str) -> StructuredReview:
        return parse_markdown_review(markdown, scale=self.score_scale)

    @staticmethod
    def _iter_deltas(resp: httpx.Response) -> Iterator[str]:
        """Yield content deltas from a vLLM SSE chat stream."""
        for line in resp.iter_lines():
            if not line or not line.startswith("data: "):
                continue
            data = line[6:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            delta = (
                chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
            )
            if delta:
                yield delta

    def _cold_start_error(self) -> str:
        return (
            f"{self.model}: cold-start exceeded Modal's 150s sync-gateway "
            f"timeout (303). Warm the container (scripts/warm-modal.sh) or "
            f"set min_containers>=1 before the study window."
        )

    # ─── public API ────────────────────────────────────────────────────────

    def generate(
        self,
        paper: ParsedPaper,
        *,
        pdf_bytes: bytes | None = None,
    ) -> GenerationResult:
        paper_text = self._canonical_text(paper)
        payload = self._payload(paper_text)
        chunks: list[str] = []
        try:
            with httpx.Client(timeout=self.timeout_s) as client:
                with client.stream(
                    "POST", self.url, json=payload, headers=self._auth_headers()
                ) as resp:
                    if resp.status_code == 303:
                        raise RuntimeError(self._cold_start_error())
                    if resp.status_code >= 400:
                        body = resp.read().decode(errors="replace")
                        raise RuntimeError(
                            f"{self.model} Modal {resp.status_code}: {body[:300]}"
                        )
                    chunks.extend(self._iter_deltas(resp))
        except httpx.HTTPError as e:
            raise RuntimeError(f"{self.model} Modal unreachable: {e}") from e

        markdown = "".join(chunks)
        if not markdown.strip():
            raise RuntimeError(f"{self.model} returned empty stream")
        return GenerationResult(
            review=self._parse(markdown),
            raw_output=markdown,
            metrics=self._metrics(paper_text, markdown),
        )

    def generate_stream(
        self,
        paper: ParsedPaper,
        *,
        pdf_bytes: bytes | None = None,
    ) -> Iterator[StreamEvent]:
        paper_text = self._canonical_text(paper)
        try:
            payload = self._payload(paper_text)
        except ValueError as e:
            yield StreamEvent(type="error", error=str(e))
            return

        chunks: list[str] = []
        try:
            with httpx.Client(timeout=self.timeout_s) as client:
                with client.stream(
                    "POST", self.url, json=payload, headers=self._auth_headers()
                ) as resp:
                    if resp.status_code == 303:
                        yield StreamEvent(type="error", error=self._cold_start_error())
                        return
                    if resp.status_code >= 400:
                        body = resp.read().decode(errors="replace")
                        yield StreamEvent(
                            type="error",
                            error=f"{self.model} Modal {resp.status_code}: {body[:300]}",
                        )
                        return
                    for delta in self._iter_deltas(resp):
                        chunks.append(delta)
                        yield StreamEvent(type="token", text=delta)
        except Exception as e:  # noqa: BLE001
            yield StreamEvent(type="error", error=str(e))
            return

        markdown = "".join(chunks)
        if not markdown.strip():
            yield StreamEvent(type="error", error=f"{self.model} returned empty stream")
            return
        yield StreamEvent(
            type="done",
            result=self._parse(markdown),
            raw_output=markdown,
            metrics=self._metrics(paper_text, markdown),
        )
