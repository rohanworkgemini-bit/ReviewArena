"""SEA-E adapter — ECNU-SEA/SEA-E via vLLM.

Mistral-7B-Instruct-v0.2 fine-tune (SEA: Standardization, Evaluation,
Analysis, EMNLP 2024 Findings, arxiv:2407.12857). apache-2.0 — the
cleanest license of the specialist reviewers.

Prompt is the verbatim `instruction_e` from the SEA repo
(inference/template.json). SEA emits a single review using **bold**
section headers (`**Summary:**`, `**Soundness:**` …) with 1-4 dim scores
("3 good") and a 1-10 rating ("6 marginally above"). We normalize the
bold headers to `## ` ATX so the shared markdown parser handles them, and
use the ICLR score scale.

SEA's canonical inference (ecnu-sea/SEA inference/inference.py) puts the
instruction in a `system` message and the paper in a `user` message —
not a single combined message. The bundled SEA-E chat template
references a Jinja `system_message` variable that is populated from the
system role; cramming everything into one user message leaves it
undefined and the vLLM server returns 400. Always send two messages.
"""
from __future__ import annotations

import re

from app.adapters._review_parse import ScoreScale
from app.adapters.vllm_base import VLLMChatAdapter
from app.schemas import StructuredReview

# Verbatim `instruction_e` from ecnu-sea/SEA inference/template.json.
_INSTRUCTION = """You are a highly experienced, conscientious, and fair academic reviewer, please help me review this paper. The review should be organized into nine sections:
1. Summary: A summary of the paper in 100-150 words.
2. Strengths/Weaknesses/Questions: The Strengths/Weaknesses/Questions of paper, which should be listed in bullet points, with each point supported by specific examples from the article where possible.
3. Soundness/Contribution/Presentation: Rate the paper's Soundness/Contribution/Presentation, and match this score to the corresponding description from the list below and provide the result. The possible scores and their descriptions are:
    1 poor
    2 fair
    3 good
    4 excellent
4. Rating: Give this paper an appropriate rating, match this rating to the corresponding description from the list below and provide the result. The possible Ratings and their descriptions are:
    1 strong reject
    2 reject, significant issues present
    3 reject, not good enough
    4 possibly reject, but has redeeming facets
    5 marginally below the acceptance threshold
    6 marginally above the acceptance threshold
    7 accept, but needs minor improvements
    8 accept, good paper
    9 strong accept, excellent work
    10 strong accept, should be highlighted at the conference
5. Paper Decision: It must include the Decision itself(Accept or Reject) and the reasons for this decision, based on the criteria of originality, methodological soundness, significance of results, and clarity and logic of presentation.

Here is the template for a review format, you must follow this format to output your review result:
**Summary:**
Summary content

**Strengths:**
- Strength 1
- Strength 2
- ...

**Weaknesses:**
- Weakness 1
- Weakness 2
- ...

**Questions:**
- Question 1
- Question 2
- ...

**Soundness:**
Soundness result

**Presentation:**
Presentation result

**Contribution:**
Contribution result

**Rating:**
Rating result

**Paper Decision:**
- Decision: Accept/Reject
- Reasons: reasons content


Please ensure your feedback is objective and constructive. The paper is as follows:"""

# Bold "**Header:**" → "## Header" so the shared ATX parser picks it up.
_BOLD_HEADER_RX = re.compile(r"^\s*\*\*(.+?):\*\*\s*$", re.MULTILINE)


class SEAAdapter(VLLMChatAdapter):
    adapter_key = "sea-e"
    env_url_var = "SEA_URL"
    default_model = "ECNU-SEA/SEA-E"
    # Mistral-7B-Instruct-v0.2: ~16k usable context. Reserve 4096 for the
    # review (SEA generates a fairly long single review).
    context_window = 16_000
    max_output_tokens = 4096
    score_scale = ScoreScale.ICLR  # dims on 1-4 ("3 good")

    # SEA card uses do_sample with no explicit temperature; use a low-ish
    # temperature + repetition penalty (base default) for stability.
    default_temperature = 0.4
    default_top_p = 0.95

    def build_messages(self, paper_text: str) -> list[dict]:
        # Verbatim from ecnu-sea/SEA inference/inference.py — instruction
        # in the system role, paper in the user role. The SEA-E chat
        # template requires both (its `system_message` Jinja variable is
        # populated from the system message).
        return [
            {"role": "system", "content": _INSTRUCTION},
            {"role": "user", "content": paper_text},
        ]

    def _parse(self, markdown: str) -> StructuredReview:
        normalized = _BOLD_HEADER_RX.sub(lambda m: f"## {m.group(1)}", markdown)
        return super()._parse(normalized)
