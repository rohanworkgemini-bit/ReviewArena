"""PDF / arXiv parsing entry points.

Two parsers live here, each producing a canonical ParsedPaper:

  - arxiv2md.parse_from_arxiv(url_or_id) → ParsedPaper
        Uses timf34's hosted arxiv2md.org service plus arXiv's Atom API
        for author metadata. Fast (~5s), no GPU, works only when the
        paper has an HTML rendering on arXiv.

  - chandra.parse_with_chandra(pdf_bytes, filename) → ParsedPaper
        Datalab's hosted /convert API (Chandra OCR-2 vision-LM under the
        hood). They handle GPU/cold-start/scaling; we just POST + poll.
        Use for arbitrary PDFs.

Marker and GROBID have been retired in favour of Chandra via Datalab.
"""
from __future__ import annotations

from app.parsing.arxiv2md import (
    Arxiv2MdError,
    normalize_arxiv_id,
    parse_from_arxiv,
)
from app.parsing.chandra import (
    ChandraError,
    chandra_api_key,
    parse_with_chandra,
)

__all__ = [
    "Arxiv2MdError",
    "ChandraError",
    "chandra_api_key",
    "normalize_arxiv_id",
    "parse_from_arxiv",
    "parse_with_chandra",
]
