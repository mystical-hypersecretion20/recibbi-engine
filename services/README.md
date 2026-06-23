# OCR sidecar services

Optional, self-contained OCR engines that run as **their own containers** instead
of inside the lean Node `api`/`worker` image. The worker reaches them over HTTP
through the generic REST OCR client (`src/ocr/rest.js`), selected with
`OCR_PROVIDER`. They are gated behind compose profiles, so a plain `up` never
builds or starts them — Tesseract stays the default.

| Dir | `OCR_PROVIDER` | Compose profile / service | Models (baked in) | Notes |
|-----|----------------|---------------------------|-------------------|-------|
| `ocr-paddle/`    | `paddle`    | `paddle` / `ocr-paddle`       | PP-OCRv6 small det+rec (~30 MB) | fast |
| `ocr-paddle-vl/` | `paddle-vl` | `paddle-vl` / `ocr-paddle-vl` | PaddleOCR-VL 1.6 full pipeline (~2 GB) | ~120 s/receipt; heavy |

Each service is a tiny stdlib HTTP server (`server.py`, no framework) that loads
its model **once at startup** and keeps it warm. The OCR logic (profiles, result
normalization) is ported from the eval harness runners at
`../../codex-tmp01-project-eval-harness/services/`.

## HTTP contract

- `GET /health` → `{"status":"ok","provider":...,"profile":...,"ready":bool}`
  (`ready` flips true once the model is loaded).
- `POST /ocr` `{"id","mimeType","imageBase64"}` →
  `{"text","lineCount","confidence","runtimeMs","profile","provider"}`.

The engines return plain transcribed `text`; the heuristic parser
(`src/parse/receiptParser.js`) turns it into line items, exactly like the
Tesseract path.

## Build inputs (gitignored — stage per machine before building)

The committed code is the Dockerfile + `server.py` + `requirements.txt`. The
**model blobs** (`*/models/`) and **internal CA certs** (`*/certs/`, so pip can
verify TLS behind the TLS-intercepting proxy) are NOT committed — stage
them into the build contexts first:

```bash
scripts/stage-paddle-models.sh   # copies model blobs from the receipt-lens-models bundle
scripts/stage-paddle-certs.sh    # exports system-trusted CAs one-per-file into */certs/
```

Then build + run via the sidecar compose profiles — see the repo `README.md`
section **PaddleOCR sidecars**.

## Platform / resources

Both images pin `linux/amd64` (paddlepaddle ships reliable CPU wheels only for
x86_64), so on Apple Silicon they run **emulated** — slower and memory-hungry.
PaddleOCR-VL's full-pipeline generation needs well over 12 GiB; on a small host,
give the podman VM more memory and/or lower `PADDLEOCR_VL_MAX_NEW_TOKENS` /
`PADDLEOCR_VL_MAX_PIXELS` (compose env on `ocr-paddle-vl`; defaults match the
eval profile). Models are baked in, so the containers need **no network at
runtime**.
