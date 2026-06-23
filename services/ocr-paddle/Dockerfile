# PaddleOCR PP-OCRv6 small OCR sidecar — self-contained, models baked in.
#
# Pinned to linux/amd64: paddlepaddle's reliable CPU wheels target x86_64. On an
# Apple-Silicon host this runs under emulation (slower), which is acceptable for
# this optional, opt-in engine. The receipt-enricher api/worker images are
# unaffected — only this sidecar carries Python + PaddleOCR + the model blobs.
FROM --platform=linux/amd64 python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/models \
    PADDLEOCR_HOME=/models/paddleocr \
    HF_HOME=/models/huggingface \
    XDG_CACHE_HOME=/models/cache \
    PADDLE_PDX_MODEL_SOURCE=bos \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT=False \
    OCR_HOST=0.0.0.0 \
    OCR_PORT=8090

WORKDIR /app

# TLS interception re-signs HTTPS with a private chain, so
# PyPI downloads fail cert verification with the stock bundle. We install the
# full set of system-trusted internal CAs (every cert your macOS System
# keychain trusts, exported one-per-file into ./certs by the operator — see
# scripts/stage-paddle-certs.sh) into the OS trust store and point pip/requests
# at the regenerated bundle. This makes pip VERIFY TLS against the internal CA chain —
# it does NOT disable certificate verification.
COPY certs/ /usr/local/share/ca-certificates/
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
# opencv-contrib-python-headless is installed explicitly (and last) to override
# the GUI opencv that paddleocr would otherwise pull in — no display in a container.
RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir -r requirements.txt \
    && python -m pip install --no-cache-dir opencv-contrib-python-headless==4.10.0.84

# Baked-in model blobs (offline). Staged into ./models by scripts/stage-paddle-models.sh
# (gitignored). PaddleOCR resolves PP-OCRv6_small_{det,rec} by NAME from this
# PaddleX cache under $HOME/.paddlex/official_models — no network at runtime.
COPY models/official_models /models/.paddlex/official_models

COPY server.py ./server.py

EXPOSE 8090

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=20 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/health',timeout=3).status==200 else 1)"

CMD ["python", "server.py"]
