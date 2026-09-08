#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../deployment/worker-versions.env
source "$project_root/deployment/worker-versions.env"
worker_root="${CODETONOMY_WORKER_ROOT:-${CODETONOMY_HOME:-$HOME/.codetonomy}/workers}"
python312="${CODETONOMY_PYTHON312:-python3.12}"

fail() { printf 'worker bootstrap: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
sha256_file() {
  if have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  elif have sha256sum; then sha256sum "$1" | awk '{print $1}'
  else fail "shasum or sha256sum is required"
  fi
}
check_python() {
  have "$python312" || fail "$python312 is required (set CODETONOMY_PYTHON312 to a Python 3.12 binary)"
	"$python312" -c 'import sys; expected=tuple(map(int, sys.argv[1].split("."))); raise SystemExit(0 if sys.version_info[:len(expected)] == expected else 1)' "$CODETONOMY_PYTHON_VERSION" || fail "$python312 must be Python $CODETONOMY_PYTHON_VERSION"
}
reference_commit() {
	awk -v repository="  $1:" '$0 == repository { found=1; next } found && $1 == "commit:" { print $2; exit }' "$project_root/references.lock.yaml"
}
check_reference_pins() {
	[[ "$(reference_commit codex)" == "$CODETONOMY_CODEX_SOURCE_COMMIT" ]] || fail "Codex deployment provenance differs from references.lock.yaml"
	[[ "$(reference_commit unlimited_ocr)" == "$UNLIMITED_OCR_COMMIT" ]] || fail "Unlimited-OCR deployment revision differs from references.lock.yaml"
	[[ "$(reference_commit tencent_agent_memory)" == "$TENCENT_MEMORY_COMMIT" ]] || fail "TencentDB Agent Memory deployment revision differs from references.lock.yaml"
}
check_requirements() {
	check_reference_pins
  [[ "$(sha256_file "$project_root/services/perception-ocr/requirements.txt")" == "$CODETONOMY_OCR_REQUIREMENTS_SHA256" ]] || fail "OCR requirements checksum does not match deployment/worker-versions.env"
	[[ "$(sha256_file "$project_root/services/perception-ocr/requirements-mlx.txt")" == "$CODETONOMY_OCR_MLX_REQUIREMENTS_SHA256" ]] || fail "MLX OCR requirements checksum does not match deployment/worker-versions.env"
	[[ "$(sha256_file "$project_root/services/perception-ocr/server.py")" == "$CODETONOMY_OCR_ADAPTER_SHA256" ]] || fail "OCR adapter checksum does not match deployment/worker-versions.env"
	[[ "$(sha256_file "$project_root/services/spreadsheet-worker/requirements.txt")" == "$CODETONOMY_SPREADSHEET_REQUIREMENTS_SHA256" ]] || fail "spreadsheet requirements checksum mismatch"
	[[ "$(sha256_file "$project_root/services/presentation-worker/requirements.txt")" == "$CODETONOMY_PRESENTATION_REQUIREMENTS_SHA256" ]] || fail "presentation requirements checksum mismatch"
	[[ "$(sha256_file "$project_root/services/backtesting-worker/requirements.txt")" == "$CODETONOMY_BACKTESTING_REQUIREMENTS_SHA256" ]] || fail "backtesting requirements checksum mismatch"
}
codex_bin() {
  if [[ -n "${CODETONOMY_CODEX_BIN:-}" ]]; then printf '%s\n' "$CODETONOMY_CODEX_BIN"
  elif [[ -x "$worker_root/codex/node_modules/.bin/codex" ]]; then printf '%s\n' "$worker_root/codex/node_modules/.bin/codex"
  else command -v codex || true
  fi
}
check_codex() {
  local binary version
  binary="$(codex_bin)"
  [[ -n "$binary" && -x "$binary" ]] || fail "Codex CLI is missing; run: bash scripts/bootstrap-workers.sh install-codex"
	version="$("$binary" --version 2>/dev/null | awk '{print $NF}')"
  [[ "$version" == "$CODETONOMY_CODEX_VERSION" ]] || fail "Codex CLI $version found; expected $CODETONOMY_CODEX_VERSION"
  printf 'Codex CLI %s: %s\n' "$version" "$binary"
}
check_managed_codex_integrity() {
	local lock="$worker_root/codex/package-lock.json" actual
	[[ -f "$lock" ]] || fail "managed Codex lockfile is missing; run: bash scripts/bootstrap-workers.sh install-codex"
	have node || fail "Node.js is required to verify the managed Codex lockfile"
	actual="$(node -e 'const fs=require("node:fs"); const lock=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(lock.packages?.["node_modules/@openai/codex"]?.integrity ?? "")' "$lock")"
	[[ "$actual" == "$CODETONOMY_CODEX_NPM_INTEGRITY" ]] || fail "managed Codex package integrity mismatch"
}
install_codex() {
	check_reference_pins
  have npm || fail "npm is required to install Codex CLI"
  mkdir -p "$worker_root/codex"
  npm install --prefix "$worker_root/codex" --save-exact --no-audit --no-fund "@openai/codex@$CODETONOMY_CODEX_VERSION"
	check_managed_codex_integrity
  CODETONOMY_CODEX_BIN="$worker_root/codex/node_modules/.bin/codex" check_codex
}
prepare_memory() {
	check_reference_pins
	local source="$worker_root/tencent-agent-memory"
	have git || fail "git is required to fetch TencentDB Agent Memory"
	mkdir -p "$worker_root"
	if [[ ! -d "$source/.git" ]]; then
		[[ ! -e "$source" ]] || fail "$source exists but is not a git checkout"
		git clone --filter=blob:none --no-checkout "$TENCENT_MEMORY_REPOSITORY" "$source"
	fi
	[[ "$(git -C "$source" remote get-url origin)" == "$TENCENT_MEMORY_REPOSITORY" ]] || fail "unexpected TencentDB Agent Memory origin"
	git -C "$source" cat-file -e "$TENCENT_MEMORY_COMMIT^{commit}" 2>/dev/null || git -C "$source" fetch --depth 1 origin "$TENCENT_MEMORY_COMMIT"
	git -C "$source" -c advice.detachedHead=false checkout --detach "$TENCENT_MEMORY_COMMIT"
	[[ "$(git -C "$source" rev-parse HEAD)" == "$TENCENT_MEMORY_COMMIT" ]] || fail "TencentDB Agent Memory revision mismatch"
}
install_memory() {
	prepare_memory
	have npm || fail "npm is required to install TencentDB Agent Memory"
	local memory_core="$worker_root/tencent-agent-memory/MemoryCore"
	if [[ -f "$memory_core/package-lock.json" || -f "$memory_core/npm-shrinkwrap.json" ]]; then
		npm ci --prefix "$memory_core" --ignore-scripts --omit=dev --legacy-peer-deps --no-audit --no-fund
	else
		npm install --prefix "$memory_core" --ignore-scripts --omit=dev --legacy-peer-deps --no-audit --no-fund --package-lock=false
	fi
	[[ -f "$memory_core/node_modules/tsx/dist/loader.mjs" ]] || fail "TencentDB Agent Memory tsx runtime is missing"
}
install_ocr() {
  check_python
  check_requirements
  mkdir -p "$worker_root"
  "$python312" -m venv "$worker_root/perception-ocr"
  "$worker_root/perception-ocr/bin/python" -m pip install --disable-pip-version-check -r "$project_root/services/perception-ocr/requirements.txt"
  "$worker_root/perception-ocr/bin/python" -m pip check
}
detect_ocr_backend() {
	have node || fail "Node.js is required to select an OCR backend"
	node "$project_root/scripts/ocr-backend.mjs"
}
local_ocr_backend() {
	local backend
	backend="$(detect_ocr_backend)"
	[[ "$backend" != "external" ]] || fail "no local OCR engine is available; use Apple Silicon, a Linux NVIDIA host, or a remote OCR endpoint"
	printf '%s\n' "$backend"
}
install_mlx() {
	[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || fail "install-mlx must run on Apple Silicon"
	install_ocr
	"$worker_root/perception-ocr/bin/python" -m pip install --disable-pip-version-check -r "$project_root/services/perception-ocr/requirements-mlx.txt"
	"$worker_root/perception-ocr/bin/python" -m pip check
	HF_HOME="${CODETONOMY_HF_CACHE:-$worker_root/huggingface}" "$worker_root/perception-ocr/bin/python" - "$UNLIMITED_OCR_MLX_MODEL" "$UNLIMITED_OCR_MLX_MODEL_REVISION" <<'PY'
from huggingface_hub import snapshot_download
import sys
snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2])
PY
}
install_ocr_engine() {
	case "$(local_ocr_backend)" in
		sglang) install_ocr; install_sglang ;;
		mlx) install_mlx ;;
	esac
}
install_artifacts() {
	check_python
	check_requirements
	mkdir -p "$worker_root"
	"$python312" -m venv "$worker_root/artifacts"
	"$worker_root/artifacts/bin/python" -m pip install --disable-pip-version-check \
		-r "$project_root/services/spreadsheet-worker/requirements.txt" \
		-r "$project_root/services/presentation-worker/requirements.txt" \
		-r "$project_root/services/backtesting-worker/requirements.txt"
	"$worker_root/artifacts/bin/python" -m pip check
	PYTHONDONTWRITEBYTECODE=1 "$worker_root/artifacts/bin/python" "$project_root/services/presentation-worker/worker.py" --self-test
}
prepare_unlimited_ocr() {
	check_reference_pins
  local source="$worker_root/unlimited-ocr"
  have git || fail "git is required to fetch Unlimited-OCR"
  mkdir -p "$worker_root"
  if [[ ! -d "$source/.git" ]]; then
    [[ ! -e "$source" ]] || fail "$source exists but is not a git checkout"
    git clone --filter=blob:none --no-checkout "$UNLIMITED_OCR_REPOSITORY" "$source"
  else
    [[ -z "$(git -C "$source" status --porcelain)" ]] || fail "Unlimited-OCR worker checkout has local changes"
  fi
  [[ "$(git -C "$source" remote get-url origin)" == "$UNLIMITED_OCR_REPOSITORY" ]] || fail "unexpected Unlimited-OCR origin"
  git -C "$source" cat-file -e "$UNLIMITED_OCR_COMMIT^{commit}" 2>/dev/null || git -C "$source" fetch --depth 1 origin "$UNLIMITED_OCR_COMMIT"
  git -C "$source" -c advice.detachedHead=false checkout --detach "$UNLIMITED_OCR_COMMIT"
  [[ "$(git -C "$source" rev-parse HEAD)" == "$UNLIMITED_OCR_COMMIT" ]] || fail "Unlimited-OCR revision mismatch"
  [[ "$(sha256_file "$source/$SGLANG_WHEEL")" == "$SGLANG_WHEEL_SHA256" ]] || fail "SGLang wheel checksum mismatch"
}
install_sglang() {
  check_python
	have nvidia-smi || fail "install-sglang must run on a supported NVIDIA worker (nvidia-smi is missing)"
	nvidia-smi -L >/dev/null || fail "nvidia-smi could not enumerate a GPU"
  prepare_unlimited_ocr
  "$python312" -m venv "$worker_root/sglang"
	"$worker_root/sglang/bin/python" -m pip install --disable-pip-version-check \
		"$worker_root/unlimited-ocr/$SGLANG_WHEEL" "kernels==$KERNELS_VERSION"
  "$worker_root/sglang/bin/python" -m pip check
	HF_HOME="${CODETONOMY_HF_CACHE:-$worker_root/huggingface}" "$worker_root/sglang/bin/python" - "$UNLIMITED_OCR_MODEL" "$UNLIMITED_OCR_MODEL_REVISION" <<'PY'
from huggingface_hub import snapshot_download
import sys
snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2])
PY
}
verify_installed() {
  check_requirements
  check_codex
  check_managed_codex_integrity
	[[ "$(git -C "$worker_root/tencent-agent-memory" rev-parse HEAD)" == "$TENCENT_MEMORY_COMMIT" ]] || fail "TencentDB Agent Memory revision mismatch"
	[[ -f "$worker_root/tencent-agent-memory/MemoryCore/node_modules/tsx/dist/loader.mjs" ]] || fail "TencentDB Agent Memory runtime is missing"
  [[ -x "$worker_root/perception-ocr/bin/python" ]] || fail "OCR adapter venv is missing"
  "$worker_root/perception-ocr/bin/python" -m pip check
  "$worker_root/perception-ocr/bin/python" - <<'PY'
from importlib.metadata import version
expected = {"pypdfium2": "5.12.1", "Pillow": "12.1.1"}
actual = {name: version(name) for name in expected}
if actual != expected:
    raise SystemExit(f"OCR package mismatch: {actual!r} != {expected!r}")
print("OCR packages:", ", ".join(f"{name}={value}" for name, value in actual.items()))
PY
  PYTHONDONTWRITEBYTECODE=1 "$worker_root/perception-ocr/bin/python" "$project_root/services/perception-ocr/server.py" --self-test
	[[ -x "$worker_root/artifacts/bin/python" ]] || fail "artifact worker venv is missing"
	"$worker_root/artifacts/bin/python" - <<'PY'
from importlib.metadata import version
expected = {"openpyxl": "3.1.5", "python-pptx": "1.0.2", "Pillow": "12.1.1"}
actual = {name: version(name) for name in expected}
if actual != expected:
    raise SystemExit(f"artifact package mismatch: {actual!r} != {expected!r}")
print("Artifact packages:", ", ".join(f"{name}={value}" for name, value in actual.items()))
PY
	PYTHONDONTWRITEBYTECODE=1 "$worker_root/artifacts/bin/python" "$project_root/services/presentation-worker/worker.py" --self-test
	case "$(local_ocr_backend)" in
	sglang)
		[[ -x "$worker_root/sglang/bin/python" ]] || fail "SGLang venv is missing"
		"$worker_root/sglang/bin/python" - "$SGLANG_VERSION" "$KERNELS_VERSION" <<'PY'
from importlib.metadata import version
import sys
expected = dict(zip(("sglang", "kernels"), sys.argv[1:]))
actual = {name: version(name) for name in expected}
if actual != expected:
    raise SystemExit(f"worker package mismatch: {actual!r} != {expected!r}")
print("Worker packages:", ", ".join(f"{name}={value}" for name, value in actual.items()))
PY
		[[ "$(git -C "$worker_root/unlimited-ocr" rev-parse HEAD)" == "$UNLIMITED_OCR_COMMIT" ]] || fail "Unlimited-OCR revision mismatch"
		HF_HOME="${CODETONOMY_HF_CACHE:-$worker_root/huggingface}" "$worker_root/sglang/bin/python" - "$UNLIMITED_OCR_MODEL" "$UNLIMITED_OCR_MODEL_REVISION" <<'PY'
from huggingface_hub import snapshot_download
import sys
snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], local_files_only=True)
PY
		printf 'OCR backend: cuda-sglang\nUnlimited-OCR source: %s\nModel revision: %s\n' "$UNLIMITED_OCR_COMMIT" "$UNLIMITED_OCR_MODEL_REVISION"
		;;
	mlx)
		HF_HOME="${CODETONOMY_HF_CACHE:-$worker_root/huggingface}" "$worker_root/perception-ocr/bin/python" - "$MLX_VLM_VERSION" "$UNLIMITED_OCR_MLX_MODEL" "$UNLIMITED_OCR_MLX_MODEL_REVISION" <<'PY'
from huggingface_hub import snapshot_download
from importlib.metadata import version
import sys
if version("mlx-vlm") != sys.argv[1]:
    raise SystemExit(f"mlx-vlm version mismatch: {version('mlx-vlm')} != {sys.argv[1]}")
snapshot_download(repo_id=sys.argv[2], revision=sys.argv[3], local_files_only=True)
print(f"OCR backend: apple-mlx\nModel revision: {sys.argv[3]}")
PY
		;;
	esac
}
check_host() {
  check_requirements
  check_python
  check_codex
  printf 'Worker root: %s\n' "$worker_root"
	printf 'OCR backend: %s\n' "$(detect_ocr_backend)"
	if have nvidia-smi; then nvidia-smi --query-gpu=name,driver_version --format=csv,noheader; fi
}

case "${1:-check}" in
  check) check_host ;;
	install-codex) install_codex ;;
	install-memory) install_memory ;;
  install-ocr) install_ocr ;;
	install-ocr-engine) install_ocr_engine ;;
	install-artifacts) install_artifacts ;;
  install-sglang) install_sglang ;;
	install-mlx) install_mlx ;;
	install-all) install_codex; install_memory; install_ocr_engine; install_artifacts; verify_installed ;;
  verify) verify_installed ;;
	*) fail "usage: $0 check|install-codex|install-memory|install-ocr|install-ocr-engine|install-artifacts|install-sglang|install-mlx|install-all|verify" ;;
esac
