#!/usr/bin/env python3
"""HTTP OCR sidecar for regular PaddleOCR PP-OCRv6 small.

Wraps the eval-harness PP-OCRv6 small runner as a long-running HTTP service so the
detector/recognizer load ONCE at startup and stay warm across requests. The
receipt-enricher worker (src/ocr/rest.js) posts an image and gets transcribed
text back; the heuristic parser turns that into line items.

Profile (matches the eval run 20260613T-paddleocr-v6-small-no-orientation-rotation-sweep-v2):
  PP-OCRv6_small_det + PP-OCRv6_small_rec, no doc-orientation/unwarping, no
  textline-orientation, CPU.

Models are baked into the image (offline); PaddleOCR resolves them from the
PaddleX cache under $HOME/.paddlex/official_models with model-source checks off.

Contract:
  GET  /health -> {"status":"ok","provider":"paddle","profile":...,"ready":bool}
  POST /ocr    {"id","mimeType","imageBase64"} -> {"text","lineCount","confidence","runtimeMs","profile","provider"}
"""

from __future__ import annotations

import base64
import json
import os
import statistics
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROVIDER = "paddle"
PROFILE = "paddleocr-v6-small-no-orientation"
PROFILE_CONFIG = {
    "text_detection_model_name": "PP-OCRv6_small_det",
    "text_recognition_model_name": "PP-OCRv6_small_rec",
    "use_doc_orientation_classify": False,
    "use_doc_unwarping": False,
    "use_textline_orientation": False,
    "device": "cpu",
}

# Loaded once at startup, reused for every request. A lock serializes predict()
# because a single PaddleOCR instance is not guaranteed thread-safe.
_ocr = None
_lock = threading.Lock()


# --- result normalization (ported from the eval harness cli.py) -------------

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


def list_field(data, names):
    for name in names:
        value = data.get(name)
        if isinstance(value, list):
            return value
    return []


def normalize_ocr_result(raw):
    data = unwrap_result(raw)
    texts = list_field(data, ["rec_texts", "texts", "rec_text", "text"])
    scores = list_field(data, ["rec_scores", "scores", "confidence", "confidences"])
    lines = []
    for index, value in enumerate(texts):
        score = None
        if index < len(scores):
            try:
                score = float(scores[index])
            except (TypeError, ValueError):
                score = None
        lines.append({"text": str(value), "confidence": score})
    confidences = [l["confidence"] for l in lines if isinstance(l["confidence"], (int, float))]
    return {
        "text": "\n".join(l["text"] for l in lines),
        "lineCount": len(lines),
        "averageConfidence": statistics.fmean(confidences) if confidences else None,
    }


# --- model load + predict ----------------------------------------------------

def build_ocr():
    from paddleocr import PaddleOCR

    return PaddleOCR(**PROFILE_CONFIG)


def ensure_ocr():
    global _ocr
    if _ocr is None:
        with _lock:
            if _ocr is None:
                started = time.perf_counter()
                _ocr = build_ocr()
                print(f"[ocr-paddle] model loaded in {(time.perf_counter() - started) * 1000:.0f}ms", flush=True)
    return _ocr


def run_ocr(image_path):
    ocr = ensure_ocr()
    started = time.perf_counter()
    with _lock:
        result = ocr.predict(image_path)
    elapsed_ms = (time.perf_counter() - started) * 1000

    pages = [normalize_ocr_result(result_to_raw(entry)) for entry in result]
    text = "\n".join(p["text"] for p in pages if p["text"]).strip()
    confidences = [p["averageConfidence"] for p in pages if isinstance(p["averageConfidence"], (int, float))]
    return {
        "text": text,
        "lineCount": sum(p["lineCount"] for p in pages),
        "confidence": statistics.fmean(confidences) if confidences else None,
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

    def log_message(self, *args):  # noqa: D401 - quiet default logging
        return

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            self._send(200, {"status": "ok", "provider": PROVIDER, "profile": PROFILE, "ready": _ocr is not None})
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

        suffix = ".jpg"
        mime = (req.get("mimeType") or "").lower()
        if "png" in mime:
            suffix = ".png"
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as handle:
                handle.write(raw)
                handle.flush()
                result = run_ocr(handle.name)
            self._send(200, result)
        except Exception as exc:  # noqa: BLE001
            print(f"[ocr-paddle] error: {exc}", flush=True)
            self._send(500, {"error": str(exc)})


def main():
    host = os.environ.get("OCR_HOST", "0.0.0.0")
    port = int(os.environ.get("OCR_PORT", "8090"))
    # Warm the model at boot so the first real request isn't slow and /health
    # flips ready=true once it's loaded.
    if os.environ.get("OCR_PRELOAD", "1").lower() in ("1", "true", "yes", "on"):
        threading.Thread(target=ensure_ocr, daemon=True).start()
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[ocr-paddle] listening on {host}:{port} (profile {PROFILE})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
