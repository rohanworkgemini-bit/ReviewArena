"""Gemini 3 Pro reviewer (Google top tier).

Thin subclass of GeminiAdapter — per-system file so the thesis has a
clean 1:1 mapping. Default temperature 0.2 matches our other Gemini
configuration (low but not zero, for stable but not deterministic
output across runs of the same paper).
"""
from __future__ import annotations

from app.adapters.gemini import GeminiAdapter


class Gemini3ProAdapter(GeminiAdapter):
    adapter_key = "gemini-3-pro"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gemini-3-pro", "temperature": 0.2, **(config or {})}
        super().__init__(cfg)
