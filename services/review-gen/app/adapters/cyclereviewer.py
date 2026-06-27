"""CycleReviewer adapter — WestlakeNLP/CycleReviewer-ML-Llama-3.1-8B via vLLM.

Llama-3.1-8B fine-tune (WestlakeNLP, CycleResearcher, arxiv:2411.00816)
that reviews papers. Trained to emit FOUR reviewer opinions separated by
"**********", each in `## Summary / ## Soundness / ...` markdown, followed
by a meta-review + paper decision.

For the arena we surface ONE review: we take the first opinion block and
parse it with the shared markdown parser. max_output_tokens is sized to
capture the first (and maybe second) opinion — generating all four costs
~7000 tokens / several minutes, which is wasteful for a single-review UI.

Prompt + sampling are verbatim from ai_researcher/cycle_reviewer.py
(system prompt, temperature 0.4, top_p 0.95).

License: CycleReviewer License (Mistral Research-based) — benchmark use
only, no formal peer review. Gated HF repo: accept terms + set HF_TOKEN.
"""
from __future__ import annotations

from app.adapters._review_parse import ScoreScale
from app.adapters.vllm_base import VLLMChatAdapter
from app.schemas import StructuredReview

# Verbatim system prompt from ai_researcher/cycle_reviewer.py.
_SYSTEM_PROMPT = """You are an expert academic reviewer tasked with providing a thorough and balanced evaluation of research papers. For each paper submitted, conduct a comprehensive review addressing the following aspects:

1. Summary: Briefly outline main points and objectives.
2. Soundness: Assess methodology and logical consistency.
3. Presentation: Evaluate clarity, organization, and visual aids.
4. Contribution: Analyze significance and novelty in the field.
5. Strengths: Identify the paper's strongest aspects.
6. Weaknesses: Point out areas for improvement.
7. Questions: Pose questions for the authors.
8. Rating: Score 1-10, justify your rating.
9. Meta Review: Provide overall assessment and recommendation (Accept/Reject).

Maintain objectivity and provide specific examples from the paper to support your evaluation.

You need to fill out **4** review opinions."""

# Reviewer opinions are separated by this marker in the model's output.
_OPINION_SEP = "**********"


class CycleReviewerAdapter(VLLMChatAdapter):
    adapter_key = "cyclereviewer-8b"
    env_url_var = "CYCLEREVIEWER_URL"
    default_model = "WestlakeNLP/CycleReviewer-ML-Llama-3.1-8B"
    # Trained at 50k context; we serve at a smaller max_model_len on L4.
    # Reserve 3072 for the (first) review.
    context_window = 19_000
    max_output_tokens = 3072
    score_scale = ScoreScale.ICLR  # Soundness/Presentation/Contribution on 1-4

    default_temperature = 0.4
    default_top_p = 0.95

    def build_messages(self, paper_text: str) -> list[dict]:
        return [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": paper_text},
        ]

    def _parse(self, markdown: str) -> StructuredReview:
        # Take the first opinion block (the model emits up to 4 separated
        # by "**********"). Prefer the first block that actually contains a
        # Summary heading; fall back to the whole text.
        blocks = [b for b in markdown.split(_OPINION_SEP) if "## Summary" in b]
        first = blocks[0] if blocks else markdown
        return super()._parse(first)
