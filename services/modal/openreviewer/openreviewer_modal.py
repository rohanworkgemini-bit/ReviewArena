"""OpenReviewer-8B on Modal — direct vLLM serving (OpenAI-compatible).

Same pattern as services/modal/deepreviewer/deepreviewer_modal.py — we
launch `vllm serve maxidl/Llama-OpenReviewer-8B` behind Modal's
@web_server so the OpenAI /v1/chat/completions endpoint is reachable.

Deploy:
    cd services/modal/openreviewer
    modal deploy openreviewer_modal.py

Llama-3.1 is a gated repo. Create the hf-token secret first if not done:
    modal secret create hf-token HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
"""
from __future__ import annotations

import modal

app = modal.App("reviewarena-openreviewer")

# Shared HF cache volume — see deepreviewer_modal.py for the rationale.
hf_volume = modal.Volume.from_name("hf-cache", create_if_missing=True)

# Same CUDA-devel base as DeepReviewer — vLLM 0.23+ needs nvcc for
# flashinfer JIT, and the cuda-12.8 devel image provides it.
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

MODEL_NAME = "maxidl/Llama-OpenReviewer-8B"
PORT = 8000


@app.function(
    image=image,
    gpu="L4",
    volumes={"/cache/huggingface": hf_volume},
    # Two secrets:
    #   1. hf-token — Llama-3.1 is a gated repo.
    #   2. modal-shared-auth — bearer token clients must present so the
    #      public Modal URL can't be hammered by anyone with the link.
    secrets=[
        modal.Secret.from_name("hf-token"),
        modal.Secret.from_name("modal-shared-auth"),
    ],
    timeout=60 * 30,
    scaledown_window=300,
    # See deepreviewer_modal.py for the cap rationale.
    min_containers=1,    # always-warm for the test window; flip back to 0 to scale-to-zero
    max_containers=1,
)
@modal.concurrent(max_inputs=4)
@modal.web_server(port=PORT, startup_timeout=600)
def serve():
    """Launch vLLM's OpenAI-compatible HTTP server for Llama-OpenReviewer-8B.

    Auth: vLLM's --api-key flag rejects any request without
    Authorization: Bearer <key>. The key comes from the
    modal-shared-auth secret.
    """
    import os
    import subprocess

    api_key = os.environ.get("MODAL_SHARED_SECRET", "").strip()
    cmd = [
        "vllm", "serve", MODEL_NAME,
        "--host", "0.0.0.0",
        "--port", str(PORT),
        "--dtype", "bfloat16",
        "--gpu-memory-utilization", "0.90",
        # Llama-3.1 supports 128k context but we cap at 32k to keep KV
        # cache reasonable on L4 (24GB VRAM) while still handling real
        # papers comfortably.
        "--max-model-len", "32768",
        "--enforce-eager",
    ]
    if api_key:
        cmd.extend(["--api-key", api_key])
    else:
        print("WARNING: MODAL_SHARED_SECRET not set — vLLM server is unauthenticated")
    # Fire-and-forget — see deepreviewer_modal.py for the rationale.
    subprocess.Popen(cmd)
