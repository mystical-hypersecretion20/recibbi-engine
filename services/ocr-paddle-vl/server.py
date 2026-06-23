#!/usr/bin/env python3
"""HTTP OCR sidecar for PaddleOCR-VL 1.6 (full pipeline).

Wraps the eval-harness PaddleOCR-VL runner as a long-running HTTP service. The
full VL bundle (VLM + layout + doc-orientation + unwarping, ~2 GB) loads ONCE at
startup and stays warm, so each receipt pays only the ~120s inference cost, not
the ~120s+ model-load cost on top. This is why the model-load amortization the
eval harness got from 1-2-4-8 chunking is unnecessary at serving time; the
acceptance driver still batches uploads 1,2,4,8 to mirror the eval shape.

Profile (matches the eval run
20260615T-paddleocr-vl-v1.6-full-pipeline-plain-250k-1024-chunked-1-2-4-8):
  pipeline v1.6, layout + doc-orientation + unwarping on, maxPixels 250000,
  minPixels 3136, maxNewTokens 1024, promptLabel auto (None), HTML/table block
  content flattened to plain OCR text.

Models are baked into the image (offline). Contract matches services/ocr-paddle.
"""

from __future__ import annotations

import base64
import json
import os
import statistics
import tempfile
import threading
import time
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROVIDER = "paddle-vl"
PROFILE = "paddleocr-vl-v1.6-full-pipeline-plain-250k-1024-chunked-1-2-4-8"

MODEL_DIR = os.environ.get("PADDLEOCR_VL_MODEL_DIR", "/models/paddleocr-vl-1.6-full-snapshot")
PIPELINE_VERSION = os.environ.get("PADDLEOCR_VL_PIPELINE_VERSION", "v1.6")
MAX_NEW_TOKENS = int(os.environ.get("PADDLEOCR_VL_MAX_NEW_TOKENS", "1024"))
MAX_PIXELS = int(os.environ.get("PADDLEOCR_VL_MAX_PIXELS", "250000"))
MIN_PIXELS = int(os.environ.get("PADDLEOCR_VL_MIN_PIXELS", "3136"))

_pipeline = None
_lock = threading.Lock()


# --- result normalization (ported from the eval harness vl cli.py) ----------

def safe_json_value(value):
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(key): safe_json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [safe_json_value(item) for item in value]
    if hasattr(value, "tolist"):
        return safe_json_value(value.tolist())
    return repr(value)


def result_to_raw(result):
    if isinstance(result, dict):
        return safe_json_value(result)
    for attribute in ("json", "res"):
        if hasattr(result, attribute):
            value = getattr(result, attribute)
            if callable(value):
                try:
                    value = value()
                except TypeError:
                    continue
            if isinstance(value, (dict, list)):
                return safe_json_value(value)
            if isinstance(value, str):
                try:
                    return json.loads(value)
                except json.JSONDecodeError:
                    return {"value": value}
    return {"repr": repr(result)}


def unwrap_result(raw):
    if isinstance(raw, dict) and isinstance(raw.get("res"), dict):
        return raw["res"]
    return raw if isinstance(raw, dict) else {}


class PlainTextHTMLParser(HTMLParser):
    BLOCK_TAGS = {"br", "p", "div", "section", "article", "table", "thead", "tbody", "tfoot", "tr", "li"}
    CELL_TAGS = {"td", "th"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")
        elif tag in self.CELL_TAGS:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")
        elif tag in self.CELL_TAGS:
            self.parts.append(" ")

    def handle_data(self, data):
        self.parts.append(data)

    def text(self):
        lines = []
        for line in "".join(self.parts).splitlines():
            cleaned = " ".join(line.split())
            if cleaned:
                lines.append(cleaned)
        return "\n".join(lines)


def html_to_text_if_needed(content):
    if "<" not in content or ">" not in content:
        return content
    parser = PlainTextHTMLParser()
    parser.feed(content)
    text = parser.text()
    return text if text.strip() else content


def normalize_result(raw):
    data = unwrap_result(raw)
    blocks = data.get("parsing_res_list")
    if not isinstance(blocks, list):
        blocks = []
    text_parts = []
    for block in blocks:
        if isinstance(block, dict):
            content = str(block.get("block_content") or "")
        elif isinstance(block, str):
            content = block
            marker = "content:\t"
            if marker in block:
                content = block.split(marker, 1)[1]
                if "\n#################" in content:
                    content = content.split("\n#################", 1)[0]
        else:
            continue
        text_parts.append(html_to_text_if_needed(content.strip()))
    text = "\n\n".join(part for part in text_parts if part.strip())
    lines = [line for line in text.splitlines() if line.strip()]
    return {"text": text, "lineCount": len(lines)}


# --- pipeline load + predict -------------------------------------------------

def build_pipeline():
    from paddleocr import PaddleOCRVL

    kwargs = {
        "pipeline_version": PIPELINE_VERSION,
        "use_doc_orientation_classify": True,
        "use_doc_unwarping": True,
        "use_layout_detection": True,
        "use_chart_recognition": False,
        "use_seal_recognition": False,
        "use_ocr_for_image_block": False,
    }
    bundle = Path(MODEL_DIR)
    vl_dir = bundle
    if bundle and not (bundle / "model.safetensors").exists():
        for child in ("PaddleOCR-VL-1.6-0.9B", "PaddleOCR-VL-1.5-0.9B", "PaddleOCR-VL-0.9B", "vl-recognition"):
            candidate = bundle / child
            if (candidate / "model.safetensors").exists():
                vl_dir = candidate
                break
    kwargs["vl_rec_model_dir"] = str(vl_dir)
    for child in ("PP-DocLayoutV3", "PP-DocLayoutV2"):
        candidate = bundle / child
        if candidate.exists():
            kwargs["layout_detection_model_dir"] = str(candidate)
            break
    candidate = bundle / "PP-LCNet_x1_0_doc_ori"
    if candidate.exists():
        kwargs["doc_orientation_classify_model_dir"] = str(candidate)
    candidate = bundle / "UVDoc"
    if candidate.exists():
        kwargs["doc_unwarping_model_dir"] = str(candidate)
    return PaddleOCRVL(**kwargs)


def ensure_pipeline():
    global _pipeline
    if _pipeline is None:
        with _lock:
            if _pipeline is None:
                started = time.perf_counter()
                _pipeline = build_pipeline()
                print(f"[ocr-paddle-vl] pipeline loaded in {(time.perf_counter() - started) * 1000:.0f}ms", flush=True)
    return _pipeline


def run_ocr(image_path):
    pipeline = ensure_pipeline()
    # The VL pipeline runs the VLM in a worker thread. The static-engine aux
    # models (layout/doc-orientation/unwarping) can leave paddle's process graph
    # mode in *static*, which the VLM thread then inherits — generation then dies
    # with "int(Tensor) is not supported in static graph mode". Force dynamic
    # (imperative) mode back on before each predict so the VLM always runs in the
    # mode it needs. No-op when already dynamic. (Surfaced under amd64 emulation;
    # the native-arm64 eval happened to avoid it via thread timing.)
    import paddle

    if not paddle.in_dynamic_mode():
        paddle.disable_static()
    started = time.perf_counter()
    with _lock:
        output = pipeline.predict(
            image_path,
            use_layout_detection=True,
            max_new_tokens=MAX_NEW_TOKENS,
            min_pixels=MIN_PIXELS,
            max_pixels=MAX_PIXELS,
        )
    elapsed_ms = (time.perf_counter() - started) * 1000
    pages = [normalize_result(result_to_raw(r)) for r in output]
    text = "\n\n".join(p["text"] for p in pages if p["text"].strip()).strip()
    return {
        "text": text,
        "lineCount": sum(p["lineCount"] for p in pages),
        "confidence": None,
        "runtimeMs": elapsed_ms,
        "profile": PROFILE,
        "provider": PROVIDER,
    }


# --- HTTP server -------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        return

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            self._send(200, {"status": "ok", "provider": PROVIDER, "profile": PROFILE, "ready": _pipeline is not None})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/ocr":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
            image_b64 = req.get("imageBase64")
            if not image_b64:
                self._send(400, {"error": "imageBase64 is required"})
                return
            raw = base64.b64decode(image_b64)
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"error": f"bad request: {exc}"})
            return

        suffix = ".png" if "png" in (req.get("mimeType") or "").lower() else ".jpg"
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as handle:
                handle.write(raw)
                handle.flush()
                result = run_ocr(handle.name)
            self._send(200, result)
        except Exception as exc:  # noqa: BLE001
            print(f"[ocr-paddle-vl] error: {exc}", flush=True)
            self._send(500, {"error": str(exc)})


def main():
    host = os.environ.get("OCR_HOST", "0.0.0.0")
    port = int(os.environ.get("OCR_PORT", "8090"))
    if os.environ.get("OCR_PRELOAD", "1").lower() in ("1", "true", "yes", "on"):
        threading.Thread(target=ensure_pipeline, daemon=True).start()
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[ocr-paddle-vl] listening on {host}:{port} (profile {PROFILE})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
