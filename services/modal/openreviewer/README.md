# OpenReviewer-8B on Modal

GPU-served Llama-OpenReviewer endpoint. Same Modal/L4 pattern as
DeepReviewer-7B but vLLM-direct (no fragile wrapper package).

## One-time setup

```bash
# Accept Llama-3.1 license on HuggingFace first:
# https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct (one-click form)
# https://huggingface.co/maxidl/Llama-OpenReviewer-8B    (if separately gated)

# Create your HF token at: https://huggingface.co/settings/tokens
# Then upload it as a Modal secret:
modal secret create hf-token HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
```

## Deploy

```bash
cd services/modal/openreviewer
modal deploy openreviewer_modal.py
```

Modal prints two URLs:
```
✓ /review  → https://<workspace>--reviewarena-openreviewer-openreviewer8b-review.modal.run
✓ /healthz → https://<workspace>--reviewarena-openreviewer-openreviewer8b-healthz.modal.run
```

Add to project-root `.env`:
```
OPENREVIEWER_URL="https://<workspace>--reviewarena-openreviewer-openreviewer8b-review.modal.run"
```

## Smoke test

```bash
modal run openreviewer_modal.py::smoke
# or
curl -sS -X POST "$OPENREVIEWER_URL" \
  -H 'content-type: application/json' \
  -d '{"paper_text": "# Title\nTest\n\n# Abstract\nA test paper.", "max_tokens": 512}' | jq .
```

## Cost

| Item | Cost |
|---|---|
| L4 GPU active | $0.80/hour |
| Volume storage (~16 GB Llama-3.1-8B) | $0.32/month |
| Idle (scale-to-zero) | $0 |
| 50-paper study | ~$0.50 |
