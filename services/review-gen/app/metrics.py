"""Automatic review-quality metrics: BLEU, ROUGE, and an LLM-judge wrapper.

All metrics are pure functions of (candidate_review, reference_review or
paper_text). Heavy deps (nltk, rouge_score) are imported lazily so the
service starts when they aren't installed; the corresponding endpoint
returns 503 in that case.
"""
from __future__ import annotations


def bleu(candidate: str, reference: str) -> float:
    """Sentence-level BLEU-4 with smoothing. Returns a value in [0, 1].

    A peer review isn't a translation, so BLEU is a *weak* similarity
    signal — useful only as one of several scores in the correlation
    analysis chapter.
    """
    try:
        from nltk.translate.bleu_score import (
            SmoothingFunction,
            sentence_bleu,
        )
    except ImportError as e:
        raise RuntimeError(
            "BLEU requires nltk. `pip install nltk` and `python -m nltk.downloader punkt`."
        ) from e

    ref_tokens = [reference.split()]
    cand_tokens = candidate.split()
    if not cand_tokens:
        return 0.0
    return float(
        sentence_bleu(ref_tokens, cand_tokens, smoothing_function=SmoothingFunction().method1)
    )


def rouge(candidate: str, reference: str) -> dict[str, float]:
    """ROUGE-1, ROUGE-2, ROUGE-L F-scores."""
    try:
        from rouge_score import rouge_scorer
    except ImportError as e:
        raise RuntimeError("ROUGE requires rouge_score. `pip install rouge_score`.") from e
    scorer = rouge_scorer.RougeScorer(["rouge1", "rouge2", "rougeL"], use_stemmer=True)
    scores = scorer.score(reference, candidate)
    return {
        "ROUGE_1": scores["rouge1"].fmeasure,
        "ROUGE_2": scores["rouge2"].fmeasure,
        "ROUGE_L": scores["rougeL"].fmeasure,
    }
