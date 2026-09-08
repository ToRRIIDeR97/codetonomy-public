# ADR 0001: Runnable control-plane vertical slice

## Decision

Use Node.js 22 and TypeScript for the control plane. Directly depend on Pi's
published agent, provider, telemetry, and TUI packages at the version matching
the pinned reference commit. Keep permissions, task compilation, capability
selection, stable cache hashes, canonical JSONL traces, and verification owned
by this harness.

The release runs single agents and bounded depth-one DAGs through the same
runtime. A deterministic fixture remains available, while configured providers
use Pi serializers behind Codetonomy-owned selection and permission boundaries.

## Reference assessment

- Pi: direct dependency. Its agent loop and TUI are already isolated packages;
  the native clipboard image hook is adapted behind a Codetonomy-owned boundary.
  Pi's coding tools remain a behavioral reference: that package pulls in its
  full coding-agent session, rendering, and binary-management layers.
  Codetonomy instead keeps a small, workspace-confined read/list/search bundle
  behind harness-owned schemas while preserving Pi's bounded-output and
  continuation behavior.
- Reasonix: behavioral reference. Its Go packages are too coupled for this
  TypeScript slice; adapt the small stable-hash, permission-precedence, and
  write-claim contracts only. Provider setup also follows its staged
  provider/key/default-model manager, bounded model refresh, and multi-select
  behavior behind Codetonomy-owned JSON and credential-file interfaces; its Go
  implementation is not reusable in this TypeScript TUI, so no source is copied.
- Codex: the installed native `codex sandbox` runner is invoked through a narrow
  argv boundary; Codex core is not embedded.
- TencentDB Agent Memory: opt-in local sidecar. The project-root memory setting performs a
  complete eligible-text index, routes workspace search through Tencent's
  project-isolated v3 API first, and keeps the harness-owned SQLite graph store
  as provenance validation and availability fallback. The pinned Codex native
  sandbox denies external network access and limits writes to the sidecar data
  directory. A dedicated runtime sibling keeps the main configuration and its
  credentials outside the sidecar's readable roots. The loopback gateway remains reachable by the parent CLI on
  Windows and macOS. Linux fails closed until the pinned sandbox can represent
  local binding without outbound network access.
- Unlimited-OCR: isolated Python HTTP gateway with revision checks,
  content-addressed asset upload, PDFium rendering, bounded output, and a
  harness-owned engine seam. Linux/NVIDIA uses the pinned SGLang adapter;
  Apple Silicon uses the pinned MLX-VLM adapter with the same base/gundam image
  settings.

## Deliberate limits

Recursive agents, dynamic graph ontologies, silent skill mutation, automatic
external actions, and multiple production database backends remain non-goals.
There is no separate Reasonix runtime integration; the already-adapted bounded
orchestration contracts are sufficient. OCR engine dependencies and optional
office-rendering dependencies are deployed separately from the TypeScript
control plane. Engine choice does not change the `OcrService` caller contract
or expose worker filesystem paths.
