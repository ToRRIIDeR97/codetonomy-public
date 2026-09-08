#!/usr/bin/env python3
"""Loopback-only, revision-pinned Unlimited-OCR adapter for Codetonomy."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from io import BytesIO
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol

MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_ASSET_BYTES = 100 * 1024 * 1024
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 50_000_000
MAX_ENCODED_IMAGE_BYTES = 64 * 1024 * 1024
MEDIA_EXTENSIONS = {
    "application/pdf": ".pdf",
    "image/bmp": ".bmp",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
SAFE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")
ASSET_ID = re.compile(r"^[a-f0-9]{64}$")


def env_required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def env_secret(name: str) -> str:
    value = env_required(name)
    if len(value) < 32 or len(value) > 4_096 or any(ord(character) < 32 for character in value):
        raise RuntimeError(f"{name} must be a 32-4096 character secret")
    return value


def sha256(value: bytes | str) -> str:
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def loopback_url(raw: str) -> str:
    parsed = urllib.parse.urlparse(raw)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise RuntimeError("OCR upstream must use loopback HTTP")
    return raw.rstrip("/")


def secure_root(raw: str) -> Path:
    lexical = Path(os.path.abspath(raw))
    if lexical.is_symlink():
        raise RuntimeError("OCR_STORAGE_ROOT cannot be a symbolic link")
    lexical.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = lexical.lstat()
    if not lexical.is_dir() or lexical.is_symlink() or (hasattr(os, "getuid") and info.st_uid != os.getuid()):
        raise RuntimeError("OCR_STORAGE_ROOT must be an owned regular directory")
    os.chmod(lexical, 0o700)
    return lexical.resolve(strict=True)


def secure_directory(raw: str, root: Path) -> Path:
    lexical = Path(os.path.abspath(raw))
    if lexical.is_symlink():
        raise RuntimeError("OCR storage directory cannot be a symbolic link")
    path = lexical.resolve(strict=False)
    if not path.is_relative_to(root):
        raise RuntimeError("OCR storage directory must be inside OCR_STORAGE_ROOT")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not path.is_dir() or path.is_symlink() or (hasattr(os, "getuid") and info.st_uid != os.getuid()):
        raise RuntimeError("OCR storage directory must be an owned regular directory")
    os.chmod(path, 0o700)
    return path.resolve(strict=True)


def asset_path(assets: Path, raw_asset: Any) -> tuple[Path, str]:
    if not isinstance(raw_asset, dict):
        raise ValueError("asset is required")
    digest = raw_asset.get("sha256")
    media_type = raw_asset.get("mediaType")
    if not isinstance(digest, str) or not ASSET_ID.fullmatch(digest):
        raise ValueError("asset.sha256 is invalid")
    if not isinstance(media_type, str) or media_type not in MEDIA_EXTENSIONS:
        raise ValueError("asset.mediaType is invalid")
    path = assets / f"{digest}{MEDIA_EXTENSIONS[media_type]}"
    if not path.exists():
        raise FileNotFoundError("OCR asset has not been uploaded")
    info = path.lstat()
    if not path.is_file() or path.is_symlink() or info.st_nlink != 1 or info.st_size > MAX_ASSET_BYTES:
        raise ValueError("OCR asset is not a regular standalone file")
    return path, digest


def encoded_image(data: bytes, mime: str, width: int, height: int) -> tuple[str, int, int]:
    if width * height > MAX_IMAGE_PIXELS:
        raise ValueError("OCR image exceeds 50 megapixels")
    encoded = base64.b64encode(data)
    if len(encoded) > MAX_ENCODED_IMAGE_BYTES:
        raise ValueError("Encoded OCR image exceeds 64 MiB")
    return f"data:{mime};base64,{encoded.decode()}", width, height


def image_data_uri(path: Path, page_number: int | None) -> tuple[str, int, int]:
    if path.suffix.lower() == ".pdf":
        try:
            import pypdfium2 as pdfium  # type: ignore
        except ImportError as error:
            raise RuntimeError("pypdfium2 is required for PDF OCR") from error
        document = pdfium.PdfDocument(path)
        try:
            page_index = (page_number or 1) - 1
            if page_index < 0 or page_index >= len(document):
                raise ValueError("pageNumber is outside the PDF")
            page = document[page_index]
            try:
                bitmap = page.render(scale=300 / 72)
                try:
                    image = bitmap.to_pil()
                    output = BytesIO()
                    image.save(output, format="PNG")
                    return encoded_image(output.getvalue(), "image/png", image.width, image.height)
                finally:
                    bitmap.close()
            finally:
                page.close()
        finally:
            document.close()
    try:
        from PIL import Image  # type: ignore
    except ImportError as error:
        raise RuntimeError("Pillow is required for image OCR") from error
    with Image.open(path) as image:
        width, height = image.size
    mime = "image/jpeg" if path.suffix.lower() in {".jpg", ".jpeg"} else f"image/{path.suffix.lower()[1:]}"
    return encoded_image(path.read_bytes(), mime, width, height)


def parse_markdown(text: str, asset_version_id: str, page_number: int, width: int, height: int) -> dict[str, Any]:
    blocks = []
    groups = [group.strip() for group in re.split(r"\n\s*\n", text) if group.strip()]
    for index, group in enumerate(groups):
        stripped = group.strip()
        if stripped.startswith("#"):
            kind = "heading"
        elif "|" in stripped and "\n" in stripped:
            kind = "table"
        elif stripped.startswith(("$$", "\\[")):
            kind = "formula"
        elif re.match(r"^(?:[-*]|\d+\.)\s", stripped):
            kind = "list"
        else:
            kind = "paragraph"
        block = {
            "blockId": sha256(f"{asset_version_id}:{page_number}:{index}:{stripped}")[:24],
            "type": kind,
            "readingOrder": index,
            "text": stripped,
            "confidence": 0.8,
            "provenance": {"assetVersionId": asset_version_id, "pageNumber": page_number, "parserId": "unlimited-ocr"},
        }
        if kind == "table":
            rows = [[cell.strip() for cell in line.strip().strip("|").split("|")] for line in stripped.splitlines()]
            block["structuredData"] = {"rows": [row for row in rows if not all(re.fullmatch(r":?-{3,}:?", cell) for cell in row)]}
        if width and height:
            block["boundingBox"] = [0, 0, width, height]
        blocks.append(block)
    return {"pageNumber": page_number, "width": width, "height": height, "blocks": blocks}


def repeated_ngram(text: str, ngram_size: int, window_size: int) -> bool:
    """Detect a repeated trailing token n-gram within the configured recent window."""
    tokens = re.findall(r"\S+", text[-32_768:])
    if len(tokens) < ngram_size * 2:
        return False
    needle = tokens[-ngram_size:]
    history_end = len(tokens) - ngram_size
    history_start = max(0, history_end - window_size - ngram_size)
    return any(tokens[index:index + ngram_size] == needle for index in range(history_start, history_end - ngram_size + 1))


def validate_request(payload: Any, model_revision: str, code_revision: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Request must be an object")
    for name in ("requestId", "idempotencyKey", "modelRevision", "parserCodeRevision"):
        if not isinstance(payload.get(name), str) or not SAFE_ID.fullmatch(payload[name]):
            raise ValueError(f"{name} is invalid")
    if payload["modelRevision"] != model_revision or payload["parserCodeRevision"] != code_revision:
        raise ValueError("Requested OCR revisions do not match this worker")
    if "assetPath" in payload:
        raise ValueError("assetPath is not accepted; upload content through /v1/assets first")
    if payload.get("imageMode") not in {"gundam", "base"}:
        raise ValueError("imageMode must be gundam or base")
    page = payload.get("pageNumber")
    if page is not None and (isinstance(page, bool) or not isinstance(page, int) or page < 1 or page > 100_000):
        raise ValueError("pageNumber is invalid")
    prompt = payload.get("prompt", "document parsing.")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 2_000:
        raise ValueError("prompt is invalid")
    settings = payload.get("settings")
    if not isinstance(settings, dict) or not isinstance(settings.get("noRepeat"), dict):
        raise ValueError("settings.noRepeat is required")
    maximum = settings.get("maxContextTokens")
    ngram = settings["noRepeat"].get("ngramSize")
    window = settings["noRepeat"].get("windowSize")
    if not isinstance(maximum, int) or not 1 <= maximum <= 65_536 or not isinstance(ngram, int) or not 1 <= ngram <= 128 or not isinstance(window, int) or not 1 <= window <= 4_096:
        raise ValueError("OCR settings are outside safe bounds")
    return payload


class OcrEngine(Protocol):
    name: str
    model: str

    def health(self) -> dict[str, Any]: ...

    def infer(self, image: str, payload: dict[str, Any]) -> str: ...


class SglangEngine:
    name = "cuda-sglang"

    def __init__(self) -> None:
        self.upstream = loopback_url(env_required("OCR_UPSTREAM_URL"))
        self.model = os.environ.get("OCR_SERVED_MODEL", "Unlimited-OCR")
        self.processor = os.environ.get("OCR_UPSTREAM_LOGIT_PROCESSOR", "").strip()
        self.token = env_secret("OCR_UPSTREAM_API_KEY")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def health(self) -> dict[str, Any]:
        try:
            request = urllib.request.Request(
                f"{self.upstream}/v1/models",
                headers={"accept": "application/json", "authorization": f"Bearer {self.token}"},
            )
            with self.opener.open(request, timeout=3) as response:
                raw = response.read(256 * 1024 + 1)
            if len(raw) > 256 * 1024:
                raise RuntimeError("model catalog exceeds 256 KiB")
            payload = json.loads(raw)
            models = payload.get("data", []) if isinstance(payload, dict) else []
            if self.model not in {item.get("id") for item in models if isinstance(item, dict)}:
                raise RuntimeError(f"served model {self.model} is not available")
            return {"status": "ok", "name": self.name, "model": self.model}
        except Exception as error:
            return {"status": "unavailable", "name": self.name, "model": self.model, "error": str(error)}

    def infer(self, image: str, payload: dict[str, Any]) -> str:
        request: dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": payload.get("prompt", "document parsing.")},
                {"type": "image_url", "image_url": {"url": image}},
            ]}],
            "max_tokens": payload["settings"]["maxContextTokens"],
            "temperature": 0,
            "skip_special_tokens": False,
            "stream": True,
            "images_config": {"image_mode": payload["imageMode"]},
            "custom_params": {
                "ngram_size": payload["settings"]["noRepeat"]["ngramSize"],
                "window_size": payload["settings"]["noRepeat"]["windowSize"],
            },
        }
        if self.processor:
            request["custom_logit_processor"] = self.processor
        body = json.dumps(request).encode()
        output = ""
        for attempt in range(3):
            try:
                upstream_request = urllib.request.Request(
                    f"{self.upstream}/v1/chat/completions",
                    data=body,
                    headers={"content-type": "application/json", "authorization": f"Bearer {self.token}"},
                )
                with self.opener.open(upstream_request, timeout=300) as response:
                    for raw_line in response:
                        line = raw_line.decode("utf8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            delta = json.loads(data)["choices"][0]["delta"].get("content", "")
                        except (KeyError, IndexError, TypeError, json.JSONDecodeError):
                            continue
                        output += delta
                        if len(output.encode()) > MAX_OUTPUT_BYTES:
                            raise RuntimeError("OCR output exceeds 8 MiB")
                        no_repeat = payload["settings"]["noRepeat"]
                        if repeated_ngram(output, no_repeat["ngramSize"], no_repeat["windowSize"]):
                            raise RuntimeError("OCR output repetition limit reached")
                return output
            except urllib.error.HTTPError as error:
                if error.code not in {502, 503, 504} or attempt == 2:
                    raise RuntimeError(f"OCR upstream failed ({error.code})") from error
                time.sleep(attempt + 1)
        raise RuntimeError("OCR upstream exhausted its retry limit")


def resolve_local_model(model: str, revision: str) -> Path:
    model_path = Path(model)
    if not model_path.exists():
        try:
            from huggingface_hub import snapshot_download  # type: ignore
            model_path = Path(snapshot_download(repo_id=model, revision=revision, local_files_only=True))
        except Exception as error:
            raise RuntimeError(f"Pinned MLX OCR model is not cached; run bootstrap-workers.sh install-mlx: {error}") from error
    if not model_path.is_dir():
        raise RuntimeError("Pinned MLX OCR model cache path is not a directory")
    return model_path


class MlxEngine:
    name = "apple-mlx"

    def __init__(self, model_revision: str) -> None:
        if platform.system() != "Darwin" or platform.machine().lower() not in {"arm64", "aarch64"}:
            raise RuntimeError("The MLX OCR engine requires Apple Silicon")
        self.model = env_required("OCR_MLX_MODEL")
        revision = env_required("OCR_MLX_MODEL_REVISION")
        if revision != model_revision:
            raise RuntimeError("OCR_MODEL_REVISION must match OCR_MLX_MODEL_REVISION")
        try:
            from mlx_vlm import load, stream_generate  # type: ignore
            from mlx_vlm.prompt_utils import apply_chat_template  # type: ignore
        except ImportError as error:
            raise RuntimeError("mlx-vlm is required for the Apple OCR engine") from error
        model_path = resolve_local_model(self.model, revision)
        self._stream_generate = stream_generate
        self._apply_chat_template = apply_chat_template
        self._model, self._processor = load(str(model_path), revision=revision)
        self._lock = threading.Lock()

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "name": self.name, "model": self.model}

    def infer(self, image: str, payload: dict[str, Any]) -> str:
        try:
            from PIL import Image  # type: ignore
        except ImportError as error:
            raise RuntimeError("Pillow is required for the Apple OCR engine") from error
        header, encoded = image.split(",", 1)
        if not header.startswith("data:image/"):
            raise ValueError("MLX OCR requires an image data URI")
        with Image.open(BytesIO(base64.b64decode(encoded, validate=True))) as opened:
            source = opened.copy()
        prompt = self._apply_chat_template(
            self._processor,
            self._model.config,
            payload.get("prompt", "document parsing."),
            num_images=1,
        )
        mode = payload["imageMode"]
        processor_options = (
            {"cropping": True, "image_size": 640, "base_size": 1024}
            if mode == "gundam"
            else {"cropping": False, "image_size": 1024, "base_size": 1024}
        )
        output = ""
        no_repeat = payload["settings"]["noRepeat"]
        with self._lock:
            for result in self._stream_generate(
                self._model,
                self._processor,
                prompt,
                image=source,
                max_tokens=payload["settings"]["maxContextTokens"],
                temperature=0,
                repetition_penalty=1.05,
                repetition_context_size=no_repeat["windowSize"],
                skip_special_tokens=False,
                **processor_options,
            ):
                output += getattr(result, "text", "")
                if len(output.encode()) > MAX_OUTPUT_BYTES:
                    raise RuntimeError("OCR output exceeds 8 MiB")
                if repeated_ngram(output, no_repeat["ngramSize"], no_repeat["windowSize"]):
                    raise RuntimeError("OCR output repetition limit reached")
        return output.replace("Ġ", " ").replace("Ċ", "\n")


def build_engine(model_revision: str) -> OcrEngine:
    name = os.environ.get("OCR_ENGINE", "sglang").strip().lower()
    if name == "sglang":
        return SglangEngine()
    if name == "mlx":
        return MlxEngine(model_revision)
    raise RuntimeError("OCR_ENGINE must be sglang or mlx")


class OcrApplication:
    def __init__(self, engine: OcrEngine | None = None) -> None:
        self.model_revision = env_required("OCR_MODEL_REVISION")
        self.code_revision = env_required("OCR_CODE_REVISION")
        self.token = env_secret("OCR_SERVICE_TOKEN")
        self.engine = engine or build_engine(self.model_revision)
        if isinstance(self.engine, SglangEngine) and self.engine.token == self.token:
            raise RuntimeError("OCR service and upstream tokens must be different")
        default_storage = Path.cwd() / ".codetonomy" / "ocr-worker"
        self.storage = secure_root(os.environ.get("OCR_STORAGE_ROOT", str(default_storage)))
        self.assets = secure_directory(os.environ.get("OCR_ASSET_DIR", str(self.storage / "assets")), self.storage)
        self.cache = secure_directory(os.environ.get("OCR_CACHE_DIR", str(self.storage / "cache")), self.storage)
        self.lock = threading.Lock()

    def upstream_health(self) -> dict[str, Any]:
        return self.engine.health()

    def store_asset(self, digest: str, media_type: str, raw: bytes) -> bool:
        if not ASSET_ID.fullmatch(digest):
            raise ValueError("asset digest is invalid")
        if media_type not in MEDIA_EXTENSIONS:
            raise ValueError("unsupported OCR asset media type")
        if not raw or len(raw) > MAX_ASSET_BYTES:
            raise ValueError("OCR asset size is invalid")
        if sha256(raw) != digest:
            raise ValueError("OCR asset digest does not match its content")
        destination = self.assets / f"{digest}{MEDIA_EXTENSIONS[media_type]}"
        with self.lock:
            if destination.exists():
                if sha256(destination.read_bytes()) != digest:
                    raise RuntimeError("stored OCR asset failed its integrity check")
                return False
            with tempfile.NamedTemporaryFile("wb", dir=self.assets, prefix=f".{digest}.", suffix=".tmp", delete=False) as temporary_file:
                temporary_file.write(raw)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
                temporary = Path(temporary_file.name)
            os.chmod(temporary, 0o600)
            os.replace(temporary, destination)
        return True

    def parse(self, raw: bytes) -> dict[str, Any]:
        payload = validate_request(json.loads(raw), self.model_revision, self.code_revision)
        path, source_hash = asset_path(self.assets, payload.get("asset"))
        expected_key = sha256(json.dumps({
            "sourceHash": source_hash,
            "pageNumber": payload.get("pageNumber"),
            "modelRevision": self.model_revision,
            "parserCodeRevision": self.code_revision,
            "imageMode": payload["imageMode"],
            "settings": payload["settings"],
            "prompt": payload.get("prompt"),
            "normalizationVersion": "1",
        }, sort_keys=True, separators=(",", ":")))
        # Accept caller IDs for tracing, but derive the cache key server-side.
        cache_path = self.cache / f"{expected_key}.json"
        with self.lock:
            if cache_path.exists():
                return json.loads(cache_path.read_text("utf8"))
        data_uri, width, height = image_data_uri(path, payload.get("pageNumber"))
        output = self.engine.infer(data_uri, payload)
        page_number = payload.get("pageNumber") or 1
        asset_version_id = f"version_{source_hash}"
        document = {
            "documentId": f"document_{source_hash}",
            "assetVersionId": asset_version_id,
            "parser": {"id": "unlimited-ocr", "version": "1", "configurationHash": expected_key},
            "pages": [parse_markdown(output, asset_version_id, page_number, width, height)],
        }
        with tempfile.NamedTemporaryFile("w", encoding="utf8", dir=self.cache, prefix=f".{cache_path.name}.", suffix=".tmp", delete=False) as temporary_file:
            json.dump(document, temporary_file, separators=(",", ":"))
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
            temporary = Path(temporary_file.name)
        os.chmod(temporary, 0o600)
        os.replace(temporary, cache_path)
        return document


class Handler(BaseHTTPRequestHandler):
    application: OcrApplication

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"ocr {self.address_string()} {format % args}\n")

    def send_json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self) -> bool:
        return self.headers.get("authorization") == f"Bearer {self.application.token}"

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_json(404, {"error": "not found"})
        elif not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
        else:
            upstream = self.application.upstream_health()
            self.send_json(200 if upstream["status"] == "ok" else 503, {"status": upstream["status"], "modelRevision": self.application.model_revision, "parserCodeRevision": self.application.code_revision, "engine": upstream})

    def do_PUT(self) -> None:
        match = re.fullmatch(r"/v1/assets/([a-f0-9]{64})", self.path)
        if not match:
            self.send_json(404, {"error": "not found"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self.send_json(400, {"error": "invalid content-length"})
            return
        if length < 1 or length > MAX_ASSET_BYTES:
            self.send_json(413, {"error": "invalid asset size"})
            return
        media_type = self.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        try:
            created = self.application.store_asset(match.group(1), media_type, self.rfile.read(length))
            self.send_json(201 if created else 200, {"sha256": match.group(1), "created": created})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def do_POST(self) -> None:
        if self.path != "/v1/ocr":
            self.send_json(404, {"error": "not found"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self.send_json(400, {"error": "invalid content-length"})
            return
        if length < 1 or length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": "invalid request size"})
            return
        try:
            self.send_json(200, self.application.parse(self.rfile.read(length)))
        except FileNotFoundError as error:
            self.send_json(404, {"error": str(error)})
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            self.send_json(502, {"error": str(error)})


def self_test() -> None:
    page = parse_markdown("# Heading\n\n| A | B |\n|---|---|\n| 1 | 2 |", "version", 1, 100, 100)
    assert [block["type"] for block in page["blocks"]] == ["heading", "table"]
    assert page["blocks"][1]["structuredData"]["rows"] == [["A", "B"], ["1", "2"]]
    try:
        loopback_url("http://user:secret@127.0.0.1:10000")
    except RuntimeError:
        pass
    else:
        raise AssertionError("credential-bearing OCR upstream URL was accepted")
    print("perception-ocr self-test passed")


def main() -> None:
    if "--self-test" in sys.argv:
        self_test()
        return
    Handler.application = OcrApplication()
    host = os.environ.get("OCR_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "::1", "localhost"}:
        raise RuntimeError("OCR service must bind to loopback")
    port = int(os.environ.get("OCR_PORT", "10001"))
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
