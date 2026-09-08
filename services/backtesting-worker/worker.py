#!/usr/bin/env python3
"""Deterministic, long-only moving-average backtesting worker."""

from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import sys
import tempfile
from datetime import date
from pathlib import Path
from typing import Any

MAX_INPUT_BYTES = 512 * 1024
MAX_DATA_BYTES = 20 * 1024 * 1024
MAX_ROWS = 20_000
CODE_VERSION = "codetonomy-backtest-v1"


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))


def text(value: Any, label: str, maximum: int = 1024) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(ord(char) < 32 for char in value):
        raise ValueError(f"{label} must be non-empty text of at most {maximum} characters")
    return value.strip()


def finite(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label} must be a finite number")
    return float(value)


def confined(workspace: str, requested: str, must_exist: bool, label: str) -> tuple[Path, str]:
    root = Path(workspace).resolve(strict=True)
    raw = Path(requested)
    if raw.is_absolute() or ".." in raw.parts or not raw.parts:
        raise ValueError(f"{label} path is outside the workspace")
    target = root.joinpath(raw)
    ancestor = target if must_exist else target.parent
    while not ancestor.exists():
        if must_exist or ancestor == root.parent:
            raise ValueError(f"{label} path does not exist")
        ancestor = ancestor.parent
    if not ancestor.resolve(strict=True).is_relative_to(root):
        raise ValueError(f"{label} path resolves outside the workspace")
    if must_exist:
        if target.is_symlink() or not target.is_file() or target.stat().st_nlink != 1:
            raise ValueError(f"{label} must be a regular standalone workspace file")
        if target.stat().st_size > MAX_DATA_BYTES:
            raise ValueError(f"{label} exceeds 20 MiB")
    return target, raw.as_posix()


def validate_spec(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("spec must be an object")
    data_path = text(raw.get("dataPath"), "dataPath")
    output_path = text(raw.get("outputPath"), "outputPath")
    if not data_path.lower().endswith(".csv") or not output_path.lower().endswith(".json"):
        raise ValueError("dataPath must be .csv and outputPath must be .json")
    short = raw.get("shortWindow")
    long = raw.get("longWindow")
    if isinstance(short, bool) or not isinstance(short, int) or isinstance(long, bool) or not isinstance(long, int) or not 2 <= short < long <= 500:
        raise ValueError("moving-average windows must satisfy 2 <= short < long <= 500")
    train_fraction = finite(raw.get("trainFraction"), "trainFraction")
    commission = finite(raw.get("commissionBps", 0), "commissionBps")
    capital = finite(raw.get("initialCapital", 100_000), "initialCapital")
    if not 0.5 <= train_fraction <= 0.9 or not 0 <= commission <= 1_000 or capital <= 0:
        raise ValueError("trainFraction, commissionBps, or initialCapital is invalid")
    return {
        "dataPath": data_path,
        "outputPath": output_path,
        "shortWindow": short,
        "longWindow": long,
        "trainFraction": train_fraction,
        "commissionBps": commission,
        "initialCapital": capital,
    }


def load_rows(path: Path) -> tuple[list[dict[str, Any]], str]:
    payload = path.read_bytes()
    if len(payload) > MAX_DATA_BYTES:
        raise ValueError("Backtest data exceeds 20 MiB")
    try:
        decoded = payload.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("Backtest CSV must be UTF-8") from error
    reader = csv.DictReader(decoded.splitlines())
    required = {"date", "open", "close"}
    if not reader.fieldnames or not required.issubset({name.strip() for name in reader.fieldnames}):
        raise ValueError("Backtest CSV requires date, open, and close columns")
    rows = []
    seen: set[str] = set()
    symbol: str | None = None
    for index, raw in enumerate(reader):
        if index >= MAX_ROWS:
            raise ValueError(f"Backtest CSV exceeds {MAX_ROWS} rows")
        day = text(raw.get("date"), f"row {index + 2} date", 32)
        date.fromisoformat(day)
        if day in seen:
            raise ValueError("Backtest dates must be unique")
        seen.add(day)
        current_symbol = (raw.get("symbol") or "asset").strip()
        if symbol is None:
            symbol = current_symbol
        elif current_symbol != symbol:
            raise ValueError("MVP backtests support one symbol per data file")
        try:
            open_price = float(raw.get("open", ""))
            close_price = float(raw.get("close", ""))
        except ValueError as error:
            raise ValueError(f"row {index + 2} has invalid prices") from error
        if not math.isfinite(open_price) or not math.isfinite(close_price) or open_price <= 0 or close_price <= 0:
            raise ValueError(f"row {index + 2} prices must be positive finite numbers")
        rows.append({"date": day, "open": open_price, "close": close_price, "symbol": symbol})
    rows.sort(key=lambda item: item["date"])
    if len(rows) < 20:
        raise ValueError("Backtest requires at least 20 observations")
    return rows, hashlib.sha256(payload).hexdigest()


def metrics(equity: list[dict[str, Any]], start: int, end: int) -> dict[str, float | int]:
    segment = equity[start:end]
    if len(segment) < 2:
        return {"return": 0.0, "maxDrawdown": 0.0, "observations": len(segment)}
    initial = segment[0]["equity"]
    peak = initial
    drawdown = 0.0
    for row in segment:
        peak = max(peak, row["equity"])
        drawdown = min(drawdown, row["equity"] / peak - 1)
    return {"return": segment[-1]["equity"] / initial - 1, "maxDrawdown": drawdown, "observations": len(segment)}


def calculate(rows: list[dict[str, Any]], spec: dict[str, Any], input_hash: str) -> dict[str, Any]:
    if len(rows) < spec["longWindow"] + 3:
        raise ValueError("Backtest requires at least longWindow + 3 observations for training and two out-of-sample observations")
    closes = [row["close"] for row in rows]
    signals = [0] * len(rows)
    for index in range(spec["longWindow"] - 1, len(rows)):
        short_average = sum(closes[index - spec["shortWindow"] + 1:index + 1]) / spec["shortWindow"]
        long_average = sum(closes[index - spec["longWindow"] + 1:index + 1]) / spec["longWindow"]
        signals[index] = int(short_average > long_average)
    cash = spec["initialCapital"]
    shares = 0.0
    fee_rate = spec["commissionBps"] / 10_000
    trades = []
    equity = []
    for index, row in enumerate(rows):
        if index:
            desired = signals[index - 1]
            if desired and shares == 0:
                quantity = cash / (row["open"] * (1 + fee_rate))
                commission = quantity * row["open"] * fee_rate
                cash -= quantity * row["open"] + commission
                shares = quantity
                trades.append({"date": row["date"], "signalDate": rows[index - 1]["date"], "side": "buy", "price": row["open"], "quantity": quantity, "commission": commission, "cashAfter": cash})
            elif not desired and shares:
                commission = shares * row["open"] * fee_rate
                cash += shares * row["open"] - commission
                trades.append({"date": row["date"], "signalDate": rows[index - 1]["date"], "side": "sell", "price": row["open"], "quantity": shares, "commission": commission, "cashAfter": cash})
                shares = 0.0
        equity.append({"date": row["date"], "equity": cash + shares * row["close"]})
    split = max(spec["longWindow"] + 1, min(len(rows) - 2, int(len(rows) * spec["trainFraction"])))
    payload = {
        "kind": "backtest",
        "schemaVersion": 1,
        "codeVersion": CODE_VERSION,
        "spec": spec,
        "inputSha256": input_hash,
        "symbol": rows[0]["symbol"],
        "split": {"index": split, "trainEnd": rows[split - 1]["date"], "outOfSampleStart": rows[split]["date"]},
        "trades": trades,
        "equity": equity,
        "metrics": {
            "total": metrics(equity, 0, len(equity)),
            "train": metrics(equity, 0, split),
            "outOfSample": metrics(equity, split - 1, len(equity)),
            "tradeCount": len(trades),
        },
        "warnings": ["A single current-symbol data file cannot eliminate survivorship bias; use a point-in-time universe before portfolio use."],
    }
    payload["resultHash"] = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return payload


def run_backtest(workspace: str, raw_spec: Any) -> dict[str, Any]:
    spec = validate_spec(raw_spec)
    data_path, data_relative = confined(workspace, spec["dataPath"], True, "Data")
    target, output_relative = confined(workspace, spec["outputPath"], False, "Output")
    rows, input_hash = load_rows(data_path)
    spec = {**spec, "dataPath": data_relative, "outputPath": output_relative}
    result = calculate(rows, spec, input_hash)
    target.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n").encode()
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=f".{target.name}.", suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return {"path": output_relative, "rows": len(rows), "trades": len(result["trades"]), "resultHash": result["resultHash"], "split": result["split"]}


def verify_backtest(workspace: str, requested: str) -> dict[str, Any]:
    target, relative_path = confined(workspace, requested, True, "Backtest")
    if target.suffix.lower() != ".json":
        raise ValueError("Backtest artifact must be JSON")
    try:
        stored = json.loads(target.read_text("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Backtest artifact is not valid UTF-8 JSON") from error
    spec = validate_spec(stored.get("spec")) if isinstance(stored, dict) else None
    if spec is None:
        raise ValueError("Backtest artifact is missing its specification")
    data_path, data_relative = confined(workspace, spec["dataPath"], True, "Data")
    rows, input_hash = load_rows(data_path)
    expected = calculate(rows, {**spec, "dataPath": data_relative, "outputPath": relative_path}, input_hash)
    schema_ok = stored.get("kind") == "backtest" and stored.get("schemaVersion") == 1 and stored.get("inputSha256") == input_hash
    lookahead_ok = all(trade.get("signalDate", "") < trade.get("date", "") for trade in stored.get("trades", []))
    warning_ok = any("survivorship" in warning.lower() for warning in stored.get("warnings", []) if isinstance(warning, str))
    ledger_ok = stored.get("trades") == expected["trades"] and stored.get("equity") == expected["equity"]
    metrics_ok = stored.get("metrics") == expected["metrics"]
    split = stored.get("split", {})
    split_ok = split == expected["split"] and split.get("trainEnd", "") < split.get("outOfSampleStart", "")
    reproducible = stored.get("resultHash") == expected["resultHash"]
    checks = [
        {"id": "data-schema-check", "passed": schema_ok, "message": f"Validated {len(rows)} ordered observations and input hash"},
        {"id": "lookahead-bias-check", "passed": lookahead_ok, "message": "All trades execute after their signal date" if lookahead_ok else "A trade uses same-day or future information"},
        {"id": "survivorship-bias-warning", "passed": warning_ok, "message": "Survivorship-bias limitation is disclosed" if warning_ok else "Survivorship-bias limitation is missing"},
        {"id": "trade-ledger-reconciliation", "passed": ledger_ok, "message": "Trade ledger and equity curve reconcile" if ledger_ok else "Trade ledger does not reconcile"},
        {"id": "metric-recalculation", "passed": metrics_ok, "message": "Metrics match independent recalculation" if metrics_ok else "Reported metrics differ from recalculation"},
        {"id": "reproducibility-check", "passed": reproducible, "message": "Fresh execution reproduced the stored result hash" if reproducible else "Fresh execution did not reproduce the result"},
        {"id": "out-of-sample-separation", "passed": split_ok, "message": "Training and out-of-sample periods are separated" if split_ok else "Out-of-sample split is invalid"},
    ]
    inspection = {"path": relative_path, "rows": len(rows), "trades": len(stored.get("trades", [])), "resultHash": stored.get("resultHash"), "split": split}
    return {"passed": all(item["passed"] for item in checks), "checks": checks, "inspection": inspection}


def main() -> None:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        fail("Request exceeds 512 KiB")
        return
    try:
        request = json.loads(raw)
        if not isinstance(request, dict) or not isinstance(request.get("workspace"), str):
            raise ValueError("Invalid request")
        operation = request.get("operation")
        if operation == "run":
            result = run_backtest(request["workspace"], request.get("spec"))
        elif operation == "verify":
            result = verify_backtest(request["workspace"], request.get("path"))
        else:
            raise ValueError("Unknown backtesting operation")
        print(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
    except Exception as error:
        fail(str(error))


if __name__ == "__main__":
    main()
