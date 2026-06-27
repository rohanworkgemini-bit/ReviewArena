"""Exploratory analytics over a corpus of reviews — for the thesis analysis
chapter.

Two outputs:
  - per-system word-frequency for word clouds,
  - topic modeling via BERTopic (or a sklearn LDA fallback when BERTopic's
    heavy deps aren't installed).

These run offline; the Node API caches results.
"""
from __future__ import annotations

import re
from collections import Counter

_STOPWORDS = frozenset(
    """
    a an and are as at be by for from has have in is it its of on or that
    the this to was were will with the their they them then there these
    those which what who whom whose can could should would may might
    paper authors work approach method propose using used use also
    however moreover furthermore therefore thus
    """.split()
)
_TOKEN_RX = re.compile(r"[a-zA-Z][a-zA-Z\-]{2,}")


def word_frequencies(reviews: list[str], top_k: int = 50) -> list[tuple[str, int]]:
    """Bag-of-words frequency, lowercase, stop-words removed.
    Returned sorted descending, capped at `top_k`."""
    counter: Counter[str] = Counter()
    for text in reviews:
        for tok in _TOKEN_RX.findall(text):
            w = tok.lower()
            if w not in _STOPWORDS:
                counter[w] += 1
    return counter.most_common(top_k)


def topic_model(reviews: list[str], n_topics: int = 8) -> list[dict]:
    """Return a list of topics: [{topic_id, terms: [str], doc_count}].

    Tries BERTopic first (clusters with rich embeddings); falls back to
    sklearn LDA when the bertopic install is unavailable.
    """
    try:
        from bertopic import BERTopic  # type: ignore[import-not-found]
    except ImportError:
        return _lda_fallback(reviews, n_topics)

    model = BERTopic(nr_topics=n_topics, calculate_probabilities=False, verbose=False)
    topics, _ = model.fit_transform(reviews)
    out: list[dict] = []
    for topic_id in set(topics):
        if topic_id == -1:
            continue  # BERTopic's "outlier" bucket
        terms = [t for t, _ in model.get_topic(topic_id)[:10]]
        out.append({"topic_id": int(topic_id), "terms": terms, "doc_count": topics.count(topic_id)})
    return out


def _lda_fallback(reviews: list[str], n_topics: int) -> list[dict]:
    try:
        from sklearn.decomposition import LatentDirichletAllocation
        from sklearn.feature_extraction.text import CountVectorizer
    except ImportError as e:
        raise RuntimeError(
            "Topic modeling needs either bertopic or scikit-learn. "
            "Install one of them."
        ) from e

    vec = CountVectorizer(max_features=2000, stop_words="english")
    X = vec.fit_transform(reviews)
    lda = LatentDirichletAllocation(n_components=n_topics, random_state=0)
    lda.fit(X)
    vocab = vec.get_feature_names_out()
    out: list[dict] = []
    doc_topics = lda.transform(X).argmax(axis=1)
    for tid in range(n_topics):
        top_idx = lda.components_[tid].argsort()[::-1][:10]
        terms = [vocab[i] for i in top_idx]
        out.append({"topic_id": tid, "terms": terms, "doc_count": int((doc_topics == tid).sum())})
    return out
