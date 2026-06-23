# PaddleOCR-VL 1.6 full-pipeline OCR sidecar — self-contained, models baked in.
#
# Pinned to linux/amd64 (paddlepaddle CPU wheels target x86_64; runs under
# emulation on Apple Silicon). The full VL bundle (~2 GB) is baked in, so this is
# a large, opt-in image — kept entirely separate from the lean api/worker images.
FROM --platform=linux/amd64 python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/models \
    HF_HOME=/models/huggingface \
    XDG_CACHE_HOME=/models/cache \
    PADDLE_PDX_MODEL_SOURCE=bos \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT=False \
    PADDLEOCR_VL_MODEL_DIR=/models/paddleocr-vl-1.6-full-snapshot \
    OCR_HOST=0.0.0.0 \
    OCR_PORT=8090

WORKDIR /app

# TLS interception: install the full set of system-trusted
# internal CAs (exported one-per-file into ./certs by scripts/stage-paddle-certs.sh)
# so pip VERIFIES PyPI downloads against the internal CA chain (does NOT disable it).
COPY certs/ /usr/local/share/ca-certificates/
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# System libs for the native deps: libgomp1 (OpenMP, paddle), libglib2.0-0 +
# libgl1 (OpenCV). paddlex[ocr] — pulled in by this VL image but NOT by the
# PP-OCRv6 sidecar — drags in the *GUI* opencv build, whose cv2 needs libGL.so.1;
# without libgl1 the server crashes on import with "libGL.so.1: cannot open
# shared object file" and never becomes ready.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 libgl1 ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir -r requirements.txt \
    && python -m pip install --no-cache-dir opencv-contrib-python-headless==4.10.0.84

# Baked-in VL bundle (offline): VLM + PP-DocLayoutV3 + PP-LCNet_x1_0_doc_ori +
# UVDoc. Staged into ./models by scripts/stage-paddle-models.sh (gitignored).
COPY models/paddleocr-vl-1.6-full-snapshot /models/paddleocr-vl-1.6-full-snapshot

COPY server.py ./server.py

EXPOSE 8090

# Generous start-period: the ~2 GB bundle takes a while to load on first boot
# (longer under amd64 emulation). /health returns ready=false until then but 200.
HEALTHCHECK --interval=20s --timeout=5s --start-period=300s --retries=30 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/health',timeout=3).status==200 else 1)"

CMD ["python", "server.py"]
