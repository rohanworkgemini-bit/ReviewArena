"""CycleReviewer-ML-Llama-3.1-8B on Modal — vLLM (OpenAI-compatible).

Same serving pattern as deepreviewer-modal / openreviewer-modal: plain
`vllm serve` behind @modal.web_server, OpenAI /v1/chat/completions, L4 GPU,
scale-to-zero, shared-secret auth via vLLM's --api-key.

CycleReviewer-ML-Llama-3.1-8B is a GATED HF repo — accept the license at
https://huggingface.co/WestlakeNLP/CycleReviewer-ML-Llama-3.1-8B and make
sure the hf-token Modal secret has access.

Deploy:
    modal deploy services/modal/cyclereviewer/cyclereviewer_modal.py
Then paste the printed URL into .env as CYCLEREVIEWER_URL.
"""
from __future__ import annotations

import modal

app = modal.App("reviewarena-cyclereviewer")

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

MODEL_NAME = "WestlakeNLP/CycleReviewer-ML-Llama-3.1-8B"
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
    """Launch vLLM's OpenAI-compatible server for CycleReviewer-8B.

    Auth via vLLM's --api-key (MODAL_SHARED_SECRET). subprocess.Popen
    (not run) so the function returns and Modal flips the gateway to live.
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
        # Trained at 50k; cap at 19k to keep the KV cache on L4 (24GB).
        "--max-model-len", "19000",
        "--enforce-eager",
    ]
    if api_key:
        cmd.extend(["--api-key", api_key])
    else:
        print("WARNING: MODAL_SHARED_SECRET not set — vLLM server is unauthenticated")
    subprocess.Popen(cmd)
