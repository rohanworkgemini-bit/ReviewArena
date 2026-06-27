# Dockerfile for services/review-gen on Cloud Run.
#
# Build context: services/review-gen/ (so the Cloud Run --source flag
# can target this dir directly without monorepo plumbing).
#
# Single stage — the Python dep tree is large (openai + anthropic +
# google-generativeai + tiktoken + httpx ~= 500 MB installed) but multi-
# stage doesn't save much because we'd still need the full venv at runtime.
# Final image ~750 MB.

FROM python:3.13-slim

WORKDIR /app

# tini = proper PID 1 (handles SIGTERM cleanly, no zombie processes).
# build-essential briefly needed for any wheel that needs C compilation.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini build-essential \
 && rm -rf /var/lib/apt/lists/*

# Install Python deps first (Docker layer cache: only re-runs when
# requirements.txt changes, not on source edits).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && apt-get purge -y build-essential \
 && apt-get autoremove -y

# Copy the application code.
COPY app app

# Non-root user — same hardening as apps/api Dockerfile.
RUN useradd --create-home --uid 10001 reviewarena
USER reviewarena

# Cloud Run env contract:
#   - PORT injected (default 8080), uvicorn binds to it
#   - REVIEWARENA_ENV=production set via --set-env-vars in the workflow
#   - REVIEW_GEN_API_KEY mounted via --set-secrets (Secret Manager)
#   - ANTHROPIC_API_KEY / OPENAI_API_KEY / etc. via --set-secrets too
# If REVIEWARENA_ENV=production AND REVIEW_GEN_API_KEY is unset, main.py
# refuses to boot — the deploy fails loudly. Intended.
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
