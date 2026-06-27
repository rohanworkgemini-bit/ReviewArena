"""SEA-E (ECNU-SEA/SEA-E) on Modal — vLLM (OpenAI-compatible).

Mistral-7B-Instruct-v0.2 fine-tune for paper review (SEA, EMNLP 2024
Findings). apache-2.0 — NOT gated, so no HF license acceptance needed
(the hf-token secret is still mounted for download throughput).

Same serving pattern as the other vLLM services: `vllm serve` behind
@modal.web_server, OpenAI /v1/chat/completions, L4, scale-to-zero,
shared-secret auth.

Deploy:
    modal deploy services/modal/sea/sea_modal.py
Then paste the printed URL into .env as SEA_URL.
"""
from __future__ import annotations

import modal

app = modal.App("reviewarena-sea")

hf_volume = modal.Volume.from_name("hf-cache", create_if_missing=True)

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.0-devel-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("git")
    .pip_install("vllm", "huggingface_hub[hf_transfer]")
    .env({
        "HF_HOME": "/cache/huggingface",
        "HUGGINGFACE_HUB_CACHE": "/cache/huggingface",
        "HF_HUB_ENABLE_HF_TRANSFER": "1",
    })
)

MODEL_NAME = "ECNU-SEA/SEA-E"
PORT = 8000


@app.function(
    image=image,
    gpu="L4",
    volumes={"/cache/huggingface": hf_volume},
    secrets=[
        modal.Secret.from_name("hf-token"),
        modal.Secret.from_name("modal-shared-auth"),
    ],
    timeout=60 * 30,
    scaledown_window=300,
    # Always-warm for the test window; flip back to 0 to scale-to-zero.
    min_containers=1,
    max_containers=1,
)
@modal.concurrent(max_inputs=4)
@modal.web_server(port=PORT, startup_timeout=600)
def serve():
    """Launch vLLM's OpenAI-compatible server for SEA-E."""
    import os
    import subprocess

    api_key = os.environ.get("MODAL_SHARED_SECRET", "").strip()
    cmd = [
        "vllm", "serve", MODEL_NAME,
        "--host", "0.0.0.0",
        "--port", str(PORT),
        "--dtype", "bfloat16",
        "--gpu-memory-utilization", "0.90",
        # Mistral-7B-Instruct-v0.2 supports 32k; SEA uses ~16k. Cap at 16k.
        "--max-model-len", "16384",
        "--enforce-eager",
    ]
    if api_key:
        cmd.extend(["--api-key", api_key])
    else:
        print("WARNING: MODAL_SHARED_SECRET not set — vLLM server is unauthenticated")
    subprocess.Popen(cmd)
