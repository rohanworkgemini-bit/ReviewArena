"""DeepReviewer-7B on Modal — direct vLLM serving (OpenAI-compatible).

Per WestlakeNLP's official HF model card:
    vllm serve "WestlakeNLP/DeepReviewer-7B"

We host that exact pattern on Modal L4 GPU and expose the OpenAI
/v1/chat/completions endpoint. Skips the `ai_researcher` Python wrapper
(which has undeclared dep issues in 0.1.0); the underlying model already
knows how to produce reviews from a chat prompt.

Deploy:
    cd services/modal/deepreviewer
    modal deploy deepreviewer_modal.py

After deploy, Modal prints a base URL. Append /v1/chat/completions for
the OpenAI-compatible endpoint. Our adapter calls it like any other LLM.
"""
from __future__ import annotations

import modal

# ─── App + image ───────────────────────────────────────────────────────────

app = modal.App("reviewarena-deepreviewer")

# Persistent volume so weights download once and survive cold-starts.
# Shared with the other Modal services — the audit's concern about
# HF lockfile races on simultaneous cold-start is theoretical and the
# trade-off (re-downloading ~15 GiB per service on first deploy) isn't
# worth it for thesis-scale use. The lockfile race in practice only
# fires if two services cold-start the SAME model at the same instant,
# which doesn't happen here (each service loads a different model).
hf_volume = modal.Volume.from_name("hf-cache", create_if_missing=True)

# CUDA-devel base — vLLM 0.23+ needs nvcc + CUDA toolkit at runtime for
# flashinfer JIT. debian_slim doesn't have either. This is Modal's
# recommended pattern for vLLM workloads.
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
        "HF_HUB_ENABLE_HF_TRANSFER": "1",   # faster weight downloads
    })
)

MODEL_NAME = "WestlakeNLP/DeepReviewer-7B"
PORT = 8000

# ─── Serving function ──────────────────────────────────────────────────────


@app.function(
    image=image,
    gpu="L4",                       # 24 GB VRAM — fits 7B FP16
    volumes={"/cache/huggingface": hf_volume},
    # Two secrets:
    #   1. hf-token — gated model download from HuggingFace.
    #      modal secret create hf-token HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
    #   2. modal-shared-auth — bearer token clients must present so the
    #      public Modal URL can't be hammered by anyone with the link.
    #      modal secret create modal-shared-auth MODAL_SHARED_SECRET=<random>
    secrets=[
        modal.Secret.from_name("hf-token"),
        modal.Secret.from_name("modal-shared-auth"),
    ],
    timeout=60 * 30,                # 30 min/request — generous for thesis-scale
    scaledown_window=300,           # spin down 5 min after last request
    # Scale to zero between sessions. max_containers=1 caps parallelism
    # at one GPU so a multi-probe warm-up can't accidentally spawn a
    # 4-container cold-start storm (each redownloading ~14 GB and
    # consuming GPU quota). Vote-mode rarely fires both DeepReviewer and
    # OpenReviewer simultaneously enough to need >1.
    min_containers=1,    # always-warm for the test window; flip back to 0 to scale-to-zero
    max_containers=1,
)
@modal.concurrent(max_inputs=4)     # vLLM continuous batching
@modal.web_server(port=PORT, startup_timeout=600)
def serve():
    """Launch vLLM's OpenAI-compatible HTTP server.

    Modal's @web_server expects this function to start an HTTP server on
    `port` that handles incoming requests. We delegate to vLLM's bundled
    server which is bit-for-bit compatible with the OpenAI Chat
    Completions API.

    Auth: vLLM's --api-key flag rejects any request without
    Authorization: Bearer <key>. The key comes from the
    modal-shared-auth secret. If unset (local dev only), the server runs
    open and prints a warning.
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
        "--max-model-len", "19000",   # 14k input + 5k output cap from HF card
        "--enforce-eager",             # faster cold start, slightly slower inference
    ]
    if api_key:
        cmd.extend(["--api-key", api_key])
    else:
        print("WARNING: MODAL_SHARED_SECRET not set — vLLM server is unauthenticated")
    # subprocess.Popen — fire-and-forget so this serve() function returns
    # immediately. Modal's @web_server requires the function to exit so
    # the gateway can flip the container to "live" state and start
    # routing. Using subprocess.run blocks forever, which leaves Modal
    # treating the container as "still starting" and returning 303 on
    # every request (despite vLLM logging "Application startup complete").
    # The trade-off: a vLLM crash AFTER startup is silent — Modal keeps
    # routing to a dead port. For thesis use this is acceptable; vLLM
    # crashes are rare and surface as gateway timeouts within seconds.
    subprocess.Popen(cmd)
