#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../deployment/worker-versions.env
source "$project_root/deployment/worker-versions.env"
worker_root="${CODETONOMY_WORKER_ROOT:-${CODETONOMY_HOME:-$HOME/.codetonomy}/workers}"

fail() { printf 'OCR worker: %s\n' "$*" >&2; exit 1; }
required() { [[ -n "${!1:-}" ]] || fail "$1 is required"; }
detect_backend() {
	local backend
	backend="$(node "$project_root/scripts/ocr-backend.mjs")" || fail "could not select an OCR backend"
	[[ "$backend" != "external" ]] || fail "no local OCR engine is available; set CODETONOMY_OCR_BACKEND for an explicitly configured worker"
	printf '%s\n' "$backend"
}
adapter_sha256() {
	if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$project_root/services/perception-ocr/server.py" | awk '{print $1}'
	elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$project_root/services/perception-ocr/server.py" | awk '{print $1}'
	else fail "shasum or sha256sum is required"
	fi
}
require_runtime() {
  required OCR_SERVICE_TOKEN
	[[ "${#OCR_SERVICE_TOKEN}" -ge 32 ]] || fail "OCR_SERVICE_TOKEN must contain at least 32 characters"
	local backend expected_model_revision
	backend="$(detect_backend)"
	export OCR_SERVICE_TOKEN OCR_ENGINE="$backend"
	if [[ "$backend" == "sglang" ]]; then
		required OCR_UPSTREAM_API_KEY
		[[ "${#OCR_UPSTREAM_API_KEY}" -ge 32 && "$OCR_SERVICE_TOKEN" != "$OCR_UPSTREAM_API_KEY" ]] || fail "OCR service and upstream tokens must be distinct and contain at least 32 characters"
		export OCR_UPSTREAM_API_KEY
		expected_model_revision="$UNLIMITED_OCR_MODEL_REVISION"
	else
		expected_model_revision="$UNLIMITED_OCR_MLX_MODEL_REVISION"
		export OCR_MLX_MODEL="$UNLIMITED_OCR_MLX_MODEL"
		export OCR_MLX_MODEL_REVISION="$UNLIMITED_OCR_MLX_MODEL_REVISION"
	fi
  export OCR_MODEL_REVISION="${OCR_MODEL_REVISION:-$expected_model_revision}"
  export OCR_CODE_REVISION="${OCR_CODE_REVISION:-$CODETONOMY_OCR_ADAPTER_SHA256}"
	[[ "$OCR_MODEL_REVISION" == "$expected_model_revision" ]] || fail "OCR_MODEL_REVISION must match the pinned $backend worker configuration"
	[[ "$OCR_CODE_REVISION" == "$CODETONOMY_OCR_ADAPTER_SHA256" ]] || fail "OCR_CODE_REVISION must match the pinned adapter configuration"
	[[ "$(adapter_sha256)" == "$CODETONOMY_OCR_ADAPTER_SHA256" ]] || fail "OCR adapter checksum does not match the pinned worker configuration"
}
run_sglang() {
	export CODETONOMY_OCR_BACKEND=sglang
  require_runtime
  local python="$worker_root/sglang/bin/python"
  [[ -x "$python" ]] || fail "SGLang is not installed; run bootstrap-workers.sh install-sglang"
	export HF_HOME="${CODETONOMY_HF_CACHE:-$worker_root/huggingface}"
	local model_path
	model_path="$("$python" - "$UNLIMITED_OCR_MODEL" "$UNLIMITED_OCR_MODEL_REVISION" <<'PY'
from huggingface_hub import snapshot_download
import sys
try:
    print(snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], local_files_only=True))
except Exception as error:
    raise SystemExit(f"pinned OCR model is not available locally: {error}")
PY
	)" || fail "pinned OCR model is not installed; run bootstrap-workers.sh install-sglang"
	[[ -d "$model_path" ]] || fail "pinned OCR model cache path is not a directory: $model_path"
	export UNLIMITED_OCR_MODEL="$model_path"
	export UNLIMITED_OCR_MODEL UNLIMITED_OCR_MODEL_REVISION UNLIMITED_OCR_SERVED_MODEL
	exec -a codetonomy-sglang "$python" -c 'import os
from sglang.launch_server import run_server
from sglang.srt.server_args import prepare_server_args
from sglang.srt.utils import kill_process_tree
args = prepare_server_args([
    "--model", os.environ["UNLIMITED_OCR_MODEL"],
    "--revision", os.environ["UNLIMITED_OCR_MODEL_REVISION"],
    "--served-model-name", os.environ["UNLIMITED_OCR_SERVED_MODEL"],
    "--attention-backend", "fa3", "--page-size", "1",
    "--mem-fraction-static", os.environ.get("OCR_GPU_MEMORY_FRACTION", "0.8"),
    "--context-length", "32768", "--enable-custom-logit-processor",
    "--disable-overlap-schedule", "--skip-server-warmup",
    "--host", "127.0.0.1", "--port", os.environ.get("OCR_UPSTREAM_PORT", "10000"),
])
args.api_key = os.environ["OCR_UPSTREAM_API_KEY"]
try:
    run_server(args)
finally:
    kill_process_tree(os.getpid(), include_parent=False)'
}
run_adapter() {
  require_runtime
  local python="$worker_root/perception-ocr/bin/python"
	[[ -x "$python" ]] || fail "OCR environment is not installed"
	export OCR_STORAGE_ROOT="${OCR_STORAGE_ROOT:-$worker_root/ocr-data}"
  export OCR_HOST=127.0.0.1
  export OCR_PORT="${OCR_PORT:-10001}"
	export HF_HOME="${CODETONOMY_HF_CACHE:-$worker_root/huggingface}"
	if [[ "$OCR_ENGINE" == "sglang" ]]; then
		local sglang_python="$worker_root/sglang/bin/python"
		[[ -x "$sglang_python" ]] || fail "SGLang is not installed"
		export OCR_UPSTREAM_URL="http://127.0.0.1:${OCR_UPSTREAM_PORT:-10000}"
		export OCR_SERVED_MODEL="$UNLIMITED_OCR_SERVED_MODEL"
		export OCR_UPSTREAM_LOGIT_PROCESSOR
		OCR_UPSTREAM_LOGIT_PROCESSOR="$($sglang_python -c 'from sglang.srt.sampling.custom_logit_processor import DeepseekOCRNoRepeatNGramLogitProcessor as P; print(P.to_str())')"
	fi
  exec "$python" "$project_root/services/perception-ocr/server.py"
}
wait_for_sglang() {
	local engine_pid="$1"
	"$worker_root/perception-ocr/bin/python" - "$engine_pid" <<'PY'
import json, os, subprocess, sys, time, urllib.request
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
request = urllib.request.Request(
    f"http://127.0.0.1:{os.environ.get('OCR_UPSTREAM_PORT', '10000')}/v1/models",
    headers={"authorization": f"Bearer {os.environ['OCR_UPSTREAM_API_KEY']}"},
)
engine_pid = int(sys.argv[1])
last_error = "no response"

def engine_alive(pid: int) -> bool:
    try:
        state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True, check=False).stdout.strip()
        if state:
            return not state.startswith("Z")
    except OSError:
        pass
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True

for _ in range(180):
    if not engine_alive(engine_pid):
        raise SystemExit(f"SGLang exited before readiness (pid={engine_pid}); last probe error: {last_error}")
    try:
        with opener.open(request, timeout=2) as response:
            payload = json.load(response)
            if response.status == 200 and payload.get("data"):
                raise SystemExit(0)
            last_error = f"unexpected readiness response: {payload!r}"
    except Exception as error:
        last_error = f"{type(error).__name__}: {error}"
    if not engine_alive(engine_pid):
        raise SystemExit(f"SGLang exited before readiness (pid={engine_pid}); last probe error: {last_error}")
    time.sleep(1)
raise SystemExit(f"SGLang did not become ready within 180 seconds (pid={engine_pid}); last probe error: {last_error}")
PY
}
start_worker() {
	local backend
	backend="$(detect_backend)"
	if [[ "$backend" == "mlx" ]]; then
		run_adapter
	fi
	export CODETONOMY_OCR_BACKEND=sglang
	"$0" sglang &
	local engine_pid=$!
	cleanup() {
		kill "$engine_pid" "${gateway_pid:-}" 2>/dev/null || true
		if kill -0 "$engine_pid" 2>/dev/null; then wait "$engine_pid" || true; fi
		if [[ -n "${gateway_pid:-}" ]] && kill -0 "$gateway_pid" 2>/dev/null; then wait "$gateway_pid" || true; fi
	}
	trap cleanup EXIT INT TERM
	if wait_for_sglang "$engine_pid"; then
		:
	else
		local readiness_status=$?
		if kill -0 "$engine_pid" 2>/dev/null; then
			fail "SGLang readiness failed (probe status $readiness_status; engine is still running)"
		fi
		local engine_status
		if wait "$engine_pid"; then engine_status=0; else engine_status=$?; fi
		fail "SGLang exited before readiness (status $engine_status; probe status $readiness_status)"
	fi
	"$0" adapter &
	local gateway_pid=$!
	while :; do
		if ! kill -0 "$engine_pid" 2>/dev/null; then
			local engine_status
			if wait "$engine_pid"; then engine_status=0; else engine_status=$?; fi
			kill "$gateway_pid" 2>/dev/null || true
			if wait "$gateway_pid"; then :; fi
			fail "SGLang exited after readiness (status $engine_status)"
		fi
		if ! kill -0 "$gateway_pid" 2>/dev/null; then
			local gateway_status
			if wait "$gateway_pid"; then gateway_status=0; else gateway_status=$?; fi
			kill "$engine_pid" 2>/dev/null || true
			if wait "$engine_pid"; then :; fi
			fail "OCR gateway exited (status $gateway_status)"
		fi
		sleep 1
	done
}
health() {
  require_runtime
  OCR_HEALTH_URL="http://127.0.0.1:${OCR_PORT:-10001}/health" \
	"$worker_root/perception-ocr/bin/python" - "$OCR_MODEL_REVISION" "$CODETONOMY_OCR_ADAPTER_SHA256" <<'PY'
import json, os, sys, urllib.request
request = urllib.request.Request(os.environ["OCR_HEALTH_URL"], headers={"authorization": f"Bearer {os.environ['OCR_SERVICE_TOKEN']}"})
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open(request, timeout=5) as response:
    payload = json.load(response)
if response.status != 200 or payload.get("status") != "ok":
    raise SystemExit(f"OCR health failed: {payload!r}")
if payload.get("modelRevision") != sys.argv[1] or payload.get("parserCodeRevision") != sys.argv[2]:
    raise SystemExit("OCR worker revision mismatch")
print(json.dumps(payload, sort_keys=True))
PY
}

case "${1:-}" in
	start) start_worker ;;
	engine) [[ "$(detect_backend)" == "sglang" ]] || fail "the Apple MLX engine runs inside the OCR gateway"; run_sglang ;;
	gateway) run_adapter ;;
  sglang) run_sglang ;;
  adapter) run_adapter ;;
  health) health ;;
	*) fail "usage: $0 start|engine|gateway|health|sglang|adapter" ;;
esac
