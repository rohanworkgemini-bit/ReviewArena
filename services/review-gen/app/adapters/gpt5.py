"""GPT-5 reviewer (OpenAI top tier).

Thin subclass of GPTAdapter — same OpenAI SDK call shape, same prompt,
same response parser. Only the default model string and adapter_key
differ. Per-system files give the thesis a clean 1:1 mapping between
DB review_systems rows and Python adapter source.

GPT-5 is a reasoning-family model: requires `max_completion_tokens`
(not `max_tokens`) and rejects non-default temperature. Both quirks are
handled by the parent's `use_max_completion_tokens` flag + omitted temp.
"""
from __future__ import annotations

from app.adapters.gpt import GPTAdapter


class GPT5Adapter(GPTAdapter):
    adapter_key = "gpt-5"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gpt-5", "use_max_completion_tokens": True, **(config or {})}
        super().__init__(cfg)
