"""GPT-5-mini reviewer (OpenAI small).

Thin subclass of GPTAdapter — see gpt5.py for the rationale on
per-system files. Same reasoning-family quirks as gpt-5 (no
temperature, `max_completion_tokens` required).
"""
from __future__ import annotations

from app.adapters.gpt import GPTAdapter


class GPT5MiniAdapter(GPTAdapter):
    adapter_key = "gpt-5-mini"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gpt-5-mini", "use_max_completion_tokens": True, **(config or {})}
        super().__init__(cfg)
