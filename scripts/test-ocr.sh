#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
worker_root="${CODETONOMY_WORKER_ROOT:-${CODETONOMY_HOME:-$HOME/.codetonomy}/workers}"
ocr_python="${CODETONOMY_OCR_PYTHON:-$worker_root/perception-ocr/bin/python}"
[[ -x "$ocr_python" ]] || ocr_python="${CODETONOMY_OCR_PYTHON:-python3}"

PYTHONDONTWRITEBYTECODE=1 "$ocr_python" "$project_root/services/perception-ocr/server.py" --self-test
PYTHONDONTWRITEBYTECODE=1 "$ocr_python" "$project_root/services/perception-ocr/test_integration.py"
