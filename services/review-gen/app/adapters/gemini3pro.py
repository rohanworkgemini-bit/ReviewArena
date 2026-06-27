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
        # gemini-3-pro-preview is dead (404 as of 2026-06). The current
        # top-tier Gemini 3 model is "gemini-3.1-pro-preview". The DB
        # row in review_systems sets `model` explicitly in config so this
        # default rarely applies, but keep it aligned to avoid foot-guns
        # if someone instantiates without overriding config.
        cfg = {"model": "gemini-3.1-pro-preview", "temperature": 0.2, **(config or {})}
        super().__init__(cfg)
