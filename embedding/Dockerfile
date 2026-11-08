# Embedding server image (BGE-M3 by default).
#
# Why Docker is now the default install path (vs. a host-side venv):
#   - No host Python version sniffing — image pins python:3.12-slim.
#   - torch>=2.6 + sentence-transformers wheels resolve once at build
#     time; no flaky pip dependency resolution on the user's machine.
#   - Model is baked into the image, so first start is fast and the
#     1.3 GB download fails fast at build time (visible) instead of
#     silently mid-run.
#   - Restart policy + healthcheck replace launchd / systemd plumbing.
#
# Trade-off: CPU only (Docker Desktop on macOS can't expose MPS; GPU
# users wanting CUDA should run the host install via
# `./install.sh embedding --native`).

FROM python:3.12-slim

ARG MODEL_NAME=BAAI/bge-m3
ARG PIP_INDEX_URL=
ENV MODEL_NAME=${MODEL_NAME} \
    PIP_DEFAULT_TIMEOUT=300 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# curl: container healthcheck via /health.
# build-essential intentionally absent — torch CPU wheels are
# precompiled and sentence-transformers is pure Python.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# torch>=2.6 closes CVE-2025-32434 (the deserialization gadget that
# bypassed torch.load(weights_only=True)). transformers 5.x refuses
# to load BGE-M3's .bin weights on anything older. Default PyPI ships
# CPU wheels for >=2.6, so no special index URL needed.
RUN pip install ${PIP_INDEX_URL:+--index-url $PIP_INDEX_URL} \
    --extra-index-url https://download.pytorch.org/whl/cpu \
    "torch>=2.6" "sentence-transformers>=3.0" "modelscope>=1.20"

# Multi-source model fetch — mirrors scripts/install/embedding-host.mts
# so users on either side of the GFW get a working source.
#   1. ModelScope — best from inside CN, no HF rate limits
#   2. HuggingFace direct
#   3. hf-mirror.com — HK-based HF proxy, last resort
# Writes the resolved load path to /app/.model_path; runtime reads it.
RUN python - <<'PY'
import os, sys
model = os.environ['MODEL_NAME']
load_path = None

try:
    from modelscope import snapshot_download
    p = snapshot_download(model)
    from sentence_transformers import SentenceTransformer
    SentenceTransformer(p)
    load_path = p
    print(f"OK: modelscope -> {p}")
except Exception as e:
    print(f"modelscope failed: {e}", file=sys.stderr)

if load_path is None:
    try:
        from sentence_transformers import SentenceTransformer
        SentenceTransformer(model)
        load_path = model
        print("OK: huggingface direct")
    except Exception as e:
        print(f"huggingface direct failed: {e}", file=sys.stderr)

if load_path is None:
    os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
    from sentence_transformers import SentenceTransformer
    SentenceTransformer(model)
    load_path = model
    print("OK: hf-mirror.com")

with open('/app/.model_path', 'w') as f:
    f.write(load_path)
PY

# Copied after the model download so a code change doesn't re-download 1.3 GB.
COPY embedding_server.py .

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
  CMD curl -fsS http://localhost:8002/health || exit 1

EXPOSE 8002

# Server reads the absolute model path that the build step settled on.
# MEMENTO_EMBEDDING_MODEL_NAME at runtime overrides for users wanting
# a different model (triggers a re-download on first start).
CMD ["sh", "-c", "exec python embedding_server.py --port 8002 \
    --model \"${MEMENTO_EMBEDDING_MODEL_NAME:-$(cat /app/.model_path)}\""]
