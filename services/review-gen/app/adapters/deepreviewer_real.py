"""DeepReviewer-7B adapter — WestlakeNLP/DeepReviewer-7B via vLLM on Modal.

Qwen2-based fine-tune for academic peer review. Served as a plain
chat model through vLLM's OpenAI-compatible API. All transport,
budgeting, streaming, 303-handling and output-parsing live in
VLLMChatAdapter; this file only carries the model-specific prompt +
declarations.

Sampling defaults follow the DeepReview paper (arxiv:2503.08569,
"temperature of 0.4") and the model's generation_config.json (top_p
0.95); repetition_penalty is added by the base class to prevent the
degeneration loops the model falls into on dense papers.

DEEPREVIEWER_URL should be the Modal base URL (without /v1/chat/...);
the base class appends the OpenAI path.
"""
from __future__ import annotations

import re

from app.adapters._review_parse import ScoreScale
from app.adapters.vllm_base import VLLMChatAdapter
from app.schemas import StructuredReview

# The real review begins at the first line-anchored "## Summary". Anything
# before it is the model's chain-of-thought preamble, which we drop so it
# can't pollute the parse.
_REAL_REVIEW_START = re.compile(r"^#{1,3}\s*summary\b", re.IGNORECASE | re.MULTILINE)

# Instruction template for DeepReviewer.
#
# DeepReviewer (Qwen2-based) emits a chain-of-thought preamble before the
# review. Two consequences we design around:
#   1. Scores are ordered RIGHT AFTER the summary so they survive even if
#      the verbose Strengths/Weaknesses sections hit the output-token cap.
#   2. We ask for the score sections to lead with the bare number so the
#      parser's first-line scan reliably finds it.
# The shared parser keeps the LONGEST body per heading, so the real
# (post-thinking) sections win over any heading-like text in the preamble.
_REVIEW_PROMPT = """You are an expert peer reviewer for a top machine-learning conference. Read the paper below and write a thorough, critical review.

Use these markdown section headers verbatim and in this exact order. Each score section must begin with the number on its own line.

## Summary
(2-4 sentences.)

## Soundness
(A single integer 1-4 on the first line, then one sentence.)

## Presentation
(A single integer 1-4 on the first line, then one sentence.)

## Contribution
(A single integer 1-4 on the first line, then one sentence.)

## Rating
(A single integer 1-10 on the first line, then one sentence.)

## Confidence
(A single integer 1-5 on the first line, then one sentence.)

## Strengths
(Concise bullet list, 3-5 items.)

## Weaknesses
(Concise bullet list, 3-6 items.)

## Questions
(Concise bullet list, 2-5 items.)

PAPER:
{paper_text}
"""


class DeepReviewerRealAdapter(VLLMChatAdapter):
    adapter_key = "deepreviewer-7b"
    env_url_var = "DEEPREVIEWER_URL"
    default_model = "WestlakeNLP/DeepReviewer-7B"
    # HF card: 14k input + 5k output. We serve at max_model_len=19000.
    # 4096 output: DeepReviewer is verbose and emits a chain-of-thought
    # preamble before the review, so it needs more room than the other
    # models to fit scores + strengths + weaknesses + questions without
    # truncation. Reserve leaves ~14k tokens for the paper.
    context_window = 19_000
    max_output_tokens = 4096
    score_scale = ScoreScale.ICLR  # Soundness/Presentation/Contribution on 1-4

    # Paper §inference: temperature 0.4. top_p 0.95 from generation_config.
    default_temperature = 0.4
    default_top_p = 0.95

    def build_messages(self, paper_text: str) -> list[dict]:
        return [{"role": "user", "content": _REVIEW_PROMPT.format(paper_text=paper_text)}]

    def _parse(self, markdown: str) -> StructuredReview:
        # Strip the chain-of-thought preamble: parse only from the first
        # real "## Summary" heading onward. Falls back to the full text if
        # the model didn't emit one.
        matches = list(_REAL_REVIEW_START.finditer(markdown))
        if matches:
            markdown = markdown[matches[-1].start():]
        return super()._parse(markdown)
