"""Adapter registry. Lazy so we don't import heavy ML deps unless asked.

Live adapter keys (must match `review_systems.adapter_key` in the DB):
  mock              — deterministic offline fallback, dev only
  gpt-4o-mini       — OpenAI GPT-4o-mini zero-shot prompted reviewer
  gemini            — Google Gemini-2.5-flash zero-shot prompted reviewer
  deepreviewer-7b   — WestlakeNLP/DeepReviewer-7B served via vLLM on Modal
  openreviewer-8b   — maxidl/Llama-OpenReviewer-8B served via vLLM on Modal

The earlier in-process "port" adapters (our reimplementations of AI
Scientist, DeepReviewer, TreeReview) have been removed in favour of
calling the published systems' real upstream models. See the
deepreviewer-modal/ and openreviewer-modal/ sibling services for the
GPU-side serving code.

Standardized integration framework (so every system gets the same input
budgeting + output normalization, and adding a new one is minimal):
  - _budget.py        — token-sized input rendering (one truncation rule)
  - _review_parse.py  — markdown/JSON → StructuredReview + score clamping
  - vllm_base.py      — VLLMChatAdapter: subclass + declare a few fields to
                        add a new OpenAI-compatible (Modal-served) model.
                        See its docstring for a copy-paste template.
"""
from __future__ import annotations

from typing import Callable

from app.adapters.base import Adapter

_FACTORIES: dict[str, Callable[[dict], Adapter]] = {}


def register(adapter_key: str, factory: Callable[[dict], Adapter]) -> None:
    _FACTORIES[adapter_key] = factory


def get(adapter_key: str, config: dict | None = None) -> Adapter:
    if adapter_key not in _FACTORIES:
        raise KeyError(f"unknown adapter_key: {adapter_key!r}")
    return _FACTORIES[adapter_key](config or {})


def known_keys() -> list[str]:
    return sorted(_FACTORIES.keys())


def _bootstrap() -> None:
    # Real adapters are wrapped in thin lazy factories so the missing-
    # API-key error only surfaces when /generate is actually called for
    # that adapter, not at process startup.
    def _gpt_factory(cfg: dict) -> Adapter:
        from app.adapters.gpt import GPTAdapter

        return GPTAdapter(cfg)

    def _gemini_factory(cfg: dict) -> Adapter:
        from app.adapters.gemini import GeminiAdapter

        return GeminiAdapter(cfg)

    def _deepreviewer_factory(cfg: dict) -> Adapter:
        from app.adapters.deepreviewer_real import DeepReviewerRealAdapter

        return DeepReviewerRealAdapter(cfg)

    def _openreviewer_factory(cfg: dict) -> Adapter:
        from app.adapters.openreviewer import OpenReviewerAdapter

        return OpenReviewerAdapter(cfg)

    def _openai_compat_factory(cfg: dict) -> Adapter:
        from app.adapters.openai_compat import OpenAICompatAdapter

        return OpenAICompatAdapter(cfg)

    def _cyclereviewer_factory(cfg: dict) -> Adapter:
        from app.adapters.cyclereviewer import CycleReviewerAdapter

        return CycleReviewerAdapter(cfg)

    def _sea_factory(cfg: dict) -> Adapter:
        from app.adapters.sea import SEAAdapter

        return SEAAdapter(cfg)

    def _claude_factory(cfg: dict) -> Adapter:
        from app.adapters.claude import ClaudeAdapter

        return ClaudeAdapter(cfg)

    # Per-system adapter factories. Each commercial reviewer system has
    # its own file (gpt5.py, gpt5mini.py, gemini3pro.py, gemini25flash.py,
    # claude.py, deepseek.py) so the thesis has a clean 1:1 mapping
    # between DB review_systems rows and Python source.
    def _gpt5_factory(cfg: dict) -> Adapter:
        from app.adapters.gpt5 import GPT5Adapter

        return GPT5Adapter(cfg)

    def _gpt5mini_factory(cfg: dict) -> Adapter:
        from app.adapters.gpt5mini import GPT5MiniAdapter

        return GPT5MiniAdapter(cfg)

    def _gemini3pro_factory(cfg: dict) -> Adapter:
        from app.adapters.gemini3pro import Gemini3ProAdapter

        return Gemini3ProAdapter(cfg)

    def _gemini25flash_factory(cfg: dict) -> Adapter:
        from app.adapters.gemini25flash import Gemini25FlashAdapter

        return Gemini25FlashAdapter(cfg)

    def _deepseek_factory(cfg: dict) -> Adapter:
        from app.adapters.deepseek import DeepSeekAdapter

        return DeepSeekAdapter(cfg)

    # Legacy keys — kept registered so historical DB rows still resolve.
    # The "gpt-4o-mini" + "gemini" keys are the base adapters that the
    # per-system subclasses inherit from; left registered for backward
    # compatibility with any unmigrated row.
    register("gpt-4o-mini", _gpt_factory)
    register("gemini", _gemini_factory)
    register("deepreviewer-7b", _deepreviewer_factory)
    register("openreviewer-8b", _openreviewer_factory)
    # Generic OpenAI-compatible adapter — still useful for ad-hoc base_url
    # overrides; not used by any active seeded system now that DeepSeek
    # has its own dedicated adapter.
    register("openai-compat", _openai_compat_factory)
    # Specialist open-weight review models served on Modal (vLLM).
    register("cyclereviewer-8b", _cyclereviewer_factory)
    register("sea-e", _sea_factory)
    # Per-system commercial reviewers (one file per system).
    register("gpt-5", _gpt5_factory)
    register("gpt-5-mini", _gpt5mini_factory)
    register("gemini-3-pro", _gemini3pro_factory)
    register("gemini-2.5-flash", _gemini25flash_factory)
    register("claude", _claude_factory)  # claude-opus-4-8 (only Claude system)
    register("deepseek-v3-2", _deepseek_factory)


_bootstrap()
