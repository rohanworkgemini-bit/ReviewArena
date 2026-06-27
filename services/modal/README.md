# `services/modal/` — GPU-served review models

Each subdirectory is a self-contained Modal app that exposes an
OpenAI-compatible HTTP endpoint. Hosted on Modal L4 GPU,
scale-to-zero between requests.

PDF parsing no longer lives here — it routes through Datalab's hosted
Chandra API (see `services/review-gen/app/parsing/chandra.py`).

## Layout

```
modal/
├── deepreviewer/   WestlakeNLP/DeepReviewer-7B (phi-4 / Qwen-2.5)
├── openreviewer/   maxidl/Llama-OpenReviewer-8B (Llama-3.1-8B fine-tune)
├── cyclereviewer/  WestlakeNLP/CycleReviewer-ML-Llama-3.1-8B
└── sea/            ECNU-SEA/SEA-E (Mistral-7B-Instruct fine-tune)
```

Each subdir has:

- `<name>_modal.py` — `modal.App` definition
- `README.md` — deploy command + endpoint URL pattern

## Deploy

```bash
modal deploy services/modal/<name>/<name>_modal.py
```

Modal prints a public URL on success. Paste it into the project-root
`.env` under the matching key (`DEEPREVIEWER_URL`, `OPENREVIEWER_URL`,
`CYCLEREVIEWER_URL`, `SEA_URL`).

## Shared infra

- All services share the `hf-cache` Modal Volume so weights download
  once across services.
- All services mount the `hf-token` secret (gated repos like Llama-3.1).
- All services mount the `modal-shared-auth` secret — a bearer token
  vLLM checks via `--api-key`. Without it, the public Modal URL would
  be open to anyone.
- All services use the `nvidia/cuda:12.8.0-devel-ubuntu22.04` base
  image (vLLM 0.23+ needs nvcc for flashinfer JIT).

## Cost

L4 GPU @ ~$0.80/hour while a container is warm, $0 idle. A 50-paper
thesis study consumes ~$0.50–1 in GPU time per system.
