#!/usr/bin/env python3
"""Runnable loopback integration check for the OCR worker."""

from __future__ import annotations

import base64
import json
import hashlib
import os
import tempfile
import threading
import sys
import types
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

from PIL import Image

from server import Handler, MlxEngine, OcrApplication, resolve_local_model

SERVICE_TOKEN = "service-secret-0123456789-abcdefgh"
UPSTREAM_TOKEN = "upstream-secret-0123456789-abcdefg"


class Upstream(BaseHTTPRequestHandler):
    calls = 0

    def log_message(self, *_args: object) -> None:
        pass

    def do_GET(self) -> None:
        assert self.headers.get("authorization") == f"Bearer {UPSTREAM_TOKEN}"
        body = json.dumps({"data": [{"id": "Unlimited-OCR"}]}).encode()
        self.send_response(200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        assert self.headers.get("authorization") == f"Bearer {UPSTREAM_TOKEN}"
        payload = json.loads(self.rfile.read(int(self.headers["content-length"])))
        assert payload["images_config"] == {"image_mode": "base"}
        assert payload["messages"][0]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")
        type(self).calls += 1
        text = "# Report\n\n| Metric | Value |\n|---|---|\n| Revenue | 42 |\n\n$$x=42$$"
        chunks = [json.dumps({"choices": [{"delta": {"content": text}}]}), "[DONE]"]
        body = "".join(f"data: {chunk}\n\n" for chunk in chunks).encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def request(url: str, token: str | None = None, payload: dict[str, object] | None = None) -> tuple[int, dict[str, object]]:
    data = json.dumps(payload).encode() if payload else None
    headers = {"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def upload(url: str, token: str, body: bytes, media_type: str) -> tuple[int, dict[str, object]]:
    headers = {"content-type": media_type, "authorization": f"Bearer {token}"}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers, method="PUT"), timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def test_mlx_engine_contract() -> None:
    captured: dict[str, object] = {}
    engine = object.__new__(MlxEngine)
    engine._model = SimpleNamespace(config={})
    engine._processor = object()
    engine._lock = threading.Lock()
    engine._apply_chat_template = lambda *_args, **_kwargs: "formatted"

    def generate(*_args: object, **kwargs: object):
        captured.update(kwargs)
        yield SimpleNamespace(text="# Apple output")

    engine._stream_generate = generate
    image = BytesIO()
    Image.new("RGB", (2, 2), "white").save(image, "PNG")
    uri = f"data:image/png;base64,{base64.b64encode(image.getvalue()).decode()}"
    payload = {
        "prompt": "document parsing.", "imageMode": "base",
        "settings": {"maxContextTokens": 4096, "noRepeat": {"ngramSize": 35, "windowSize": 128}},
    }
    assert engine.infer(uri, payload) == "# Apple output"
    assert captured["cropping"] is False and captured["image_size"] == 1024 and captured["base_size"] == 1024


def test_mlx_model_preflight_is_cache_only() -> None:
    calls: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="codetonomy-ocr-model-") as directory:
        snapshot = Path(directory) / "snapshot"
        snapshot.mkdir()
        hub = types.ModuleType("huggingface_hub")
        hub.snapshot_download = lambda **kwargs: calls.append(kwargs) or str(snapshot)  # type: ignore[attr-defined]
        previous = sys.modules.get("huggingface_hub")
        sys.modules["huggingface_hub"] = hub
        try:
            assert resolve_local_model("baidu/Unlimited-OCR", "model-rev") == snapshot
        finally:
            if previous is None:
                del sys.modules["huggingface_hub"]
            else:
                sys.modules["huggingface_hub"] = previous
    assert calls == [{"repo_id": "baidu/Unlimited-OCR", "revision": "model-rev", "local_files_only": True}]


def main() -> None:
    test_mlx_engine_contract()
    test_mlx_model_preflight_is_cache_only()
    with tempfile.TemporaryDirectory(prefix="codetonomy-ocr-test-") as directory:
        root = Path(directory)
        Image.new("RGB", (80, 60), "white").save(root / "report.pdf", "PDF")
        asset = (root / "report.pdf").read_bytes()
        digest = hashlib.sha256(asset).hexdigest()
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        os.environ.update({
            "OCR_ENGINE": "sglang",
            "OCR_UPSTREAM_URL": f"http://127.0.0.1:{upstream.server_port}",
            "OCR_MODEL_REVISION": "model-rev",
            "OCR_CODE_REVISION": "code-rev",
            "OCR_SERVICE_TOKEN": SERVICE_TOKEN,
            "OCR_UPSTREAM_API_KEY": UPSTREAM_TOKEN,
            "OCR_STORAGE_ROOT": str(root / "worker-storage"),
        })
        Handler.application = OcrApplication()
        worker = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=worker.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{worker.server_port}"
        assert request(f"{base}/health")[0] == 401
        assert request(f"{base}/health", SERVICE_TOKEN)[0] == 200
        assert upload(f"{base}/v1/assets/{digest}", SERVICE_TOKEN, asset, "application/pdf")[0] == 201
        assert upload(f"{base}/v1/assets/{digest}", SERVICE_TOKEN, asset, "application/pdf")[0] == 200
        assert upload(f"{base}/v1/assets/{'0' * 64}", SERVICE_TOKEN, asset, "application/pdf")[0] == 400
        (root / "report.pdf").unlink()
        payload: dict[str, object] = {
            "requestId": "request-1", "idempotencyKey": "key-1", "asset": {"sha256": digest, "mediaType": "application/pdf"}, "pageNumber": 1,
            "prompt": "document parsing.", "imageMode": "base", "modelRevision": "model-rev", "parserCodeRevision": "code-rev",
            "settings": {"maxContextTokens": 32768, "noRepeat": {"ngramSize": 35, "windowSize": 128}},
        }
        status, document = request(f"{base}/v1/ocr", SERVICE_TOKEN, payload)
        assert status == 200, document
        page = document["pages"][0]  # type: ignore[index]
        assert page["width"] > 0 and page["height"] > 0
        assert page["blocks"][1]["structuredData"]["rows"] == [["Metric", "Value"], ["Revenue", "42"]]
        assert request(f"{base}/v1/ocr", SERVICE_TOKEN, payload)[0] == 200
        assert Upstream.calls == 1
        path_payload = {**payload, "assetPath": str(root / "report.pdf")}
        assert request(f"{base}/v1/ocr", SERVICE_TOKEN, path_payload)[0] == 400
        missing_payload = {**payload, "asset": {"sha256": "f" * 64, "mediaType": "application/pdf"}}
        assert request(f"{base}/v1/ocr", SERVICE_TOKEN, missing_payload)[0] == 404
        payload["modelRevision"] = "wrong"
        assert request(f"{base}/v1/ocr", SERVICE_TOKEN, payload)[0] == 400
        worker.shutdown()
        upstream.shutdown()
    print("perception-ocr integration test passed")


if __name__ == "__main__":
    main()
