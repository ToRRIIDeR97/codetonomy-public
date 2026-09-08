# Keep OCR callers and operations independent of the inference platform

Codetonomy keeps `OcrService.parse` and the authenticated OCR gateway stable, uploads assets by SHA-256 instead of sharing host paths, and selects an internal engine adapter per worker: pinned SGLang on Linux/NVIDIA or pinned MLX-VLM on Apple Silicon. A single CUDA/Metal binary was rejected because the proven runtimes have different installation and preprocessing contracts; those differences stay behind the gateway and each backend must pass the same transport, revision, output, and health checks before production use.
