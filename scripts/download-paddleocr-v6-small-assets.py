#!/usr/bin/env python3
"""Download/cache the PP-OCRv6 small detector and recognizer.

Replicated from ../codex-receipt-ocr-paddleocr-downloads/download-paddleocr-v6-small-assets.py
and extended with SHA-256 integrity: after resolving the model cache it can pack
the official_models into a portable tarball AND write a SHA256SUMS.txt covering
every file in the cache, so a redistributed bundle can be checksum-verified
(`shasum -a 256 -c SHA256SUMS.txt`) — matching the integrity model of the
codex `paddleocr-v6-small-rotation-sweep-assets.tar.gz` distribution.

It expects PaddleOCR and PaddlePaddle to be installed in the active Python
environment. It does not run the eval harness; it only forces PaddleOCR to
resolve/cache the PP-OCRv6 small detector and recognizer under the requested
cache root.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path


# Portable default cache root (no hardcoded username): honor PADDLEOCR_CACHE_ROOT,
# else fall back to ~/receipt-lens-models/paddleocr/3.7.0 (expanded in main()).
DEFAULT_OUTPUT_DIR = os.environ.get(
    "PADDLEOCR_CACHE_ROOT", "~/receipt-lens-models/paddleocr/3.7.0"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download PP-OCRv6 small assets.")
    parser.add_argument(
        "--output-dir",
        default=DEFAULT_OUTPUT_DIR,
        help=(
            "Cache root where PaddleOCR/PaddleX should store model assets "
            "(default: $PADDLEOCR_CACHE_ROOT or ~/receipt-lens-models/paddleocr/3.7.0)."
        ),
    )
    parser.add_argument(
        "--model-source",
        default="bos",
        help="PaddleX model source. Default matches the eval harness environment.",
    )
    parser.add_argument(
        "--insecure-download",
        action="store_true",
        help="Disable TLS verification for constrained managed-network environments.",
    )
    parser.add_argument(
        "--tarball",
        default=None,
        help="If set, pack the resolved official_models into this .tar.gz and write SHA256SUMS.txt.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Replace an existing tarball before writing.",
    )
    return parser.parse_args()


def maybe_disable_tls_verification() -> None:
    import ssl

    import requests
    import urllib3

    ssl._create_default_https_context = ssl._create_unverified_context
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    original_request = requests.sessions.Session.request

    def request_without_verification(self, method, url, **kwargs):
        kwargs.setdefault("verify", False)
        return original_request(self, method, url, **kwargs)

    requests.sessions.Session.request = request_without_verification


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_sha256sums(root: Path, sums_path: Path) -> int:
    """Write a `shasum -a 256 -c`-compatible file for every file under root."""
    files = sorted(p for p in root.rglob("*") if p.is_file() and p != sums_path)
    with open(sums_path, "w", encoding="utf-8") as handle:
        for path in files:
            rel = path.relative_to(root).as_posix()
            handle.write(f"{sha256_of(path)}  {rel}\n")
    return len(files)


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    os.environ.setdefault("PADDLEOCR_HOME", str(output_dir / "paddleocr"))
    os.environ.setdefault("HF_HOME", str(output_dir / "huggingface"))
    os.environ.setdefault("XDG_CACHE_HOME", str(output_dir / "cache"))
    os.environ.setdefault("HOME", str(output_dir))
    os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", args.model_source)
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "False")
    if args.insecure_download:
        os.environ.setdefault("PADDLEOCR_INSECURE_DOWNLOAD", "1")
        maybe_disable_tls_verification()

    from paddleocr import PaddleOCR

    PaddleOCR(
        text_detection_model_name="PP-OCRv6_small_det",
        text_recognition_model_name="PP-OCRv6_small_rec",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
    )

    official_models = output_dir / ".paddlex" / "official_models"
    expected = [
        official_models / "PP-OCRv6_small_det",
        official_models / "PP-OCRv6_small_rec",
    ]
    missing = [path for path in expected if not path.exists()]
    if missing:
        raise SystemExit(f"Missing expected model directories: {missing}")

    print("PP-OCRv6 small assets are available:")
    for path in expected:
        print(path)

    if args.tarball:
        import tarfile

        tarball = Path(args.tarball).expanduser().resolve()
        if tarball.exists() and not args.force:
            raise SystemExit(f"{tarball} already exists. Pass --force to replace it.")
        if tarball.exists():
            tarball.unlink()

        sums_path = official_models / "SHA256SUMS.txt"
        count = write_sha256sums(official_models, sums_path)
        print(f"Wrote {sums_path} ({count} files)")

        tarball.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(tarball, "w:gz") as tar:
            tar.add(official_models, arcname="official_models")
        digest = sha256_of(tarball)
        with open(tarball.parent / "SHA256SUMS.txt", "w", encoding="utf-8") as handle:
            handle.write(f"{digest}  {tarball.name}\n")
        print(f"Created {tarball}")
        print(f"  sha256 {digest}")
        print(f"  verify: (cd {tarball.parent} && shasum -a 256 -c SHA256SUMS.txt)")


if __name__ == "__main__":
    main()
