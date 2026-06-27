"""Gemini 2.5 Flash reviewer (Google small).

Thin subclass of GeminiAdapter — see gemini3pro.py for rationale.
Flash is the cheap, low-latency tier; same prompt and parser as Pro.
"""
from __future__ import annotations

from app.adapters.gemini import GeminiAdapter


class Gemini25FlashAdapter(GeminiAdapter):
    adapter_key = "gemini-2.5-flash"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gemini-2.5-flash", "temperature": 0.2, **(config or {})}
        super().__init__(cfg)
