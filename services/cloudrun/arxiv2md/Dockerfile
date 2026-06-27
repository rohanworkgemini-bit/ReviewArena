# Self-hosted arxiv2md — single-stage Dockerfile for Cloud Run.
#
# We pin to a commit of timf34/arxiv2md so an upstream breaking change
# never silently alters our parser output. To refresh: bump ARXIV2MD_REV
# below and re-deploy.
#
# Why not multi-stage like upstream's Dockerfile: Cloud Run cold-start
# pulls the WHOLE image, so trimming a few MB matters less than the
# multi-stage build complexity. Single-stage is easier to debug.
#
# Cost notes:
#   - Pure CPU, no GPU. ~$0.00 with scale-to-zero under GCP free tier
#     (240k vCPU-sec/month free).
#   - First cold start ~3-5s after idle. Invisible inside the ~20-60s
#     downstream parse anyway.

FROM python:3.11-slim

# git needed for the clone step below; build-essential for any C ext
# (BeautifulSoup pulls lxml on some platforms).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        gcc \
    && rm -rf /var/lib/apt/lists/*

# Clone arxiv2md at a pinned ref. Branch "main" is fine for now; pin to
# a commit SHA after we confirm the deploy works end-to-end.
ARG ARXIV2MD_REV=main
RUN git clone --depth 1 --branch ${ARXIV2MD_REV} https://github.com/timf34/arxiv2md /opt/arxiv2md

WORKDIR /opt/arxiv2md

# Install runtime deps exactly as upstream pins them in requirements.txt,
# then install the package itself in editable mode so the `arxiv2md` and
# `server` modules under src/ are importable.
RUN pip install --no-cache-dir -r requirements.txt \
 && pip install --no-cache-dir -e .

# arxiv2md writes a request cache to .arxiv2md_cache by default. Ensure
# the dir exists with permissive perms (Cloud Run runs as a non-root
# user in some configurations).
RUN mkdir -p /opt/arxiv2md/.arxiv2md_cache && chmod 777 /opt/arxiv2md/.arxiv2md_cache

# Cloud Run injects PORT (defaults to 8080). uvicorn must bind it.
ENV PORT=8080
EXPOSE 8080

# arxiv2md's layout is src/{arxiv2md,server}/. uvicorn's --app-dir tells
# it where to find the server package. --host 0.0.0.0 is mandatory on
# Cloud Run (the default 127.0.0.1 doesn't accept the proxy traffic).
CMD ["sh", "-c", "uvicorn server.main:app --host 0.0.0.0 --port ${PORT} --app-dir /opt/arxiv2md/src"]
