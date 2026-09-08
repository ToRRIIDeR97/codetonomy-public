# ADR 0002: Bash-shaped workspace facade

## Status

Experimental. By user decision on 2026-09-06, indexed workspace search selects
Bash by default, including MemoryDB-enabled CLI and TUI runs. Structured tools
remain the default without indexed search. An explicit tool-interface selection
always wins. This default change does not establish benchmark superiority or
replace the graduation criteria below.

## Decision

Offer a `bash` model tool that accepts one ordinary non-interactive Bash
command string. A small deterministic parser recognizes read-only operations
that Codetonomy can accelerate without losing the command's meaning. Direct `ls`, single-file `cat`, `head`, and bounded `sed -n` reads reuse
the workspace-confined implementations. `rg` always retains literal or native
regular-expression semantics. When ranked project search is configured, the
existing `search_workspace` tool is exposed beside Bash rather than inferred
from punctuation or phrasing in an `rg` query. The tool does not name its
configured backend.

The parser is an optimizer, not the Bash compatibility or security boundary.
If syntax is unsupported by the optimizer, or a parsed operation would lose
semantics such as regular-expression behavior, the original unmodified command
runs through native Bash in the Codex OS sandbox. Read-only presets use a
read-only project sandbox and derive `inspect_workspace` permission; write
presets derive `run_workspace_command` permission and retain approval behavior.
Bash itself handles general pipelines and redirects, substitutions, variables,
assignments, grouping, comments, and filename expansion. The driver never
interpolates retrieved content or host-generated values into the command.

Callers can explicitly select the experiment with `--tool-interface bash`, or
override the MemoryDB default with `--tool-interface structured`. The cache key
includes the resolved interface and search-mode prompt. Structured indexed,
structured literal, Bash indexed, and Bash literal runs receive distinct
system prompts. Bash prompts and model-visible tool results do not name the
search implementation. A single cached command planner is shared by permission
checks and execution. Traces and the evaluation database record the outer tool
ID, translated operation ID, planner route (`translated`, `semantic-native`, or
`parse-fallback`), stable route reason, search backend, and the existing latency
and output metrics.

## Reference assessment

The pinned Pi Bash tool is a useful behavioral reference, but it delegates
local execution safety to its caller and therefore cannot replace Codetonomy's
permission and sandbox path. The pinned Codex CLI and Reasonix implementations
both execute a real platform shell inside a host-owned sandbox and use parsing
for control or safety decisions rather than attempting to emulate the whole
shell. Codetonomy follows that boundary without copying their parser code.
TencentDB Agent Memory informs ranked retrieval, but it does not provide a Bash
parser or exact ripgrep semantics.

The implementation therefore reuses Codetonomy's existing typed tools and
contains an original small TypeScript tokenizer. No third-party source was
copied or modified, so `THIRD_PARTY_REUSE.yaml` does not change.

## Consequences

Models get a familiar command-shaped interface backed by real Bash when the
accelerator cannot preserve meaning. Ranked retrieval remains an explicit deep
tool with `path:line:excerpt` results, while Bash handles literal and regular-
expression search. Backend details remain telemetry-only.
Windows hosts prefer Git Bash, can use `CODETONOMY_BASH_BIN`, and retain native
Windows cwd handling while commands use workspace-relative `/` paths. Shell and
program availability can still differ by platform and is reported in receipts.

The command is passed as one argv element to
`bash --noprofile --norc -c`; no retrieved content is interpolated into it. The
translated or native permission target, filtered environment, bounded process
runner, read-only or writable filesystem policy, network policy, and native
Codex sandbox remain the security boundary.

## Graduation experiment

This first implementation instruments individual structured or Bash runs and
keeps their CLI benchmark identities separate. A paired scheduler, confidence
interval calculator, and combined interface report are a later phase; the
current `--tool-interface` flag alone is not graduation evidence.

Keep structured tools as the control and randomly alternate the control and
Bash facade for the same pinned task/model/provider pairs. Use at least 30 runs
per cell across read, edit, test, and documentation tasks on Windows and Linux.
Pin repository revision, prompts, MemoryDB snapshot, tool versions, permission
mode, and cache state; warm and cold cache runs are separate cells.

Graduate the facade only if its 95% confidence interval is non-inferior to the
control by no more than two percentage points for verified completion and it
does not regress any hard safety criterion. Report median and p95 values for
input/output/repair tokens, cache-read tokens and prefix survival, first-token
and end-to-end latency, tool latency/output bytes, tool retries, parse
rejections, permission denials, and cost per verified success. Also report task
acceptance coverage, including required tests and documentation updates. Replay
the captured Bash corpus and report planner route and reason distributions; a
low translation rate is a performance signal, not permission to emulate more
of the shell with lossy behavior.

The hard safety criteria are zero workspace escapes, protected-path reads,
permission or tool-ceiling bypasses, host-value command injection, unsandboxed
shell execution, and network-policy bypasses in the adversarial corpus. Cross-platform acceptance
requires identical parser fixtures and canonical operation IDs on Windows and
Linux; external command availability and native stdout may differ and must be
reported separately. Ranked retrieval is accepted only through the explicit
search tool. Prompts, schemas, and result text must not disclose the configured
search backend, while traces must retain it for comparison. `rg -F` must remain
deterministic literal search.

## Repair evidence update — 2026-09-03

The native Bash route keeps its real execution argv. A parsed single command can
also carry semantic argv for verification. Compound strings and successful
fallbacks do not prove that a requested command passed. Translated reads preserve
all result paths, and native command failures retain uncertain effects. Command
rewind remains incomplete outside the bounded snapshot scope. Native `/workspace`
mount semantics are not implied by translated virtual paths.

## Correctness and replay update, 2026-09-06

All rg searches and file listings now use native Bash. Repeated pattern options
fall back before an operation can discard an earlier pattern. Single-pattern
searches and file listings use the ripgrep-semantics route reason. Regex searches
retain regular-expression. Compound commands use shell-output unless a contained
operation already supplies a native reason. Multi-file cat also stays native.
The original command is passed unchanged through the existing permission and
filtered-environment path. Empty native stdout remains empty.

This deliberately reduces translation coverage. The workspace walker does not
implement gitignore, hidden-file selection, or rg formatting. Translating its
excerpts also changed pipeline input and conditional exit behavior. Native rg
owns those semantics. No reference parser or ignore implementation was copied.
The pinned Codex shell runtime, Pi Bash tool, Reasonix shell execution metadata,
and Tencent Agent Memory ranked search were inspected in the original checkout.
Existing native execution is the smallest reusable implementation; a new ignore
parser or cache has no demonstrated benefit here. Reuse and license records are
unchanged.

Direct accelerated reads remain bounded excerpts, with virtual paths and range
or truncation notices. Standalone ls remains a deterministic protected-path
listing, not a metadata-compatible ls. Native pipelines receive raw subprocess
output before the final tool-output limit. Native /workspace mounting remains
platform-dependent. A restricted tool profile without native execution can no
longer answer rg through translation; it fails closed instead of widening its
ceiling.

Run node --import tsx scripts/replay-bash.ts for the offline report, or run
node --import tsx --test tests/bash-replay.test.ts for regression assertions.
The corpus sanitizes observed command shapes already retained in the 29-command
paid-run fixture in tests/bash-facade.test.ts. Audit cases add repeated patterns,
ignore and hidden files, spaces, missing matches, status, and conditional pipes.
Only synthetic temporary files are executed. Native tools are prerequisites;
unavailability is an explicit skip. Native output is compared exactly; direct
read excerpts normalize CRLF and one trailing newline. Fixtures avoid unordered
multi-file match output. Durations vary; providerTokens is null. The existing
parseStatus, planReason, durationMs, and outputBytes field names are reused.

The 600-line synthetic read returns 19,992 bytes; the existing 12-line range read
returns 380 bytes. One unchanged repeated range is recorded. Guidance now names
unfamiliar behavior and repeated broad exploration as reasons for ranked search,
and prefers existing range reads once a path is known. No automatic deduplication
or shortening is justified by this small corpus. Explicit search remains optional,
backend neutral, and limited to four indexed calls. Deterministic prompt checks
do not prove better model retrieval or provider token savings.

The parser now classifies an explicit path that resolves above the workspace as
`workspace-escape`, and workspace-confined native fallback rejects that plan
before starting Bash. Explicit full-access mode retains its documented host access.
Paths such as `../../README.md` remain valid when the selected `cwd` keeps them
inside the workspace. The earlier Windows sibling canary used a system temporary
directory and tested broader host-read isolation than this facade promises. It
has been replaced by the concrete path-escape assertion. Protected-path checks,
filtered environment, write confinement, and the OS sandbox remain independent
layers. The merged quality workflow passed its full Windows, Linux, and macOS
test matrices, including sandbox checks.

For a follow-up paid experiment, use larger pinned repositories and repeated
matched tasks with exact glm-5.3-flash and deepseek-v4-flash model IDs. Cross
structured/Bash and MemoryDB on/off as separate factors; alternate matched run
order, keep task/model/settings fixed, impose no overall deadline, and retain
failures. Pair cache-read/write telemetry and provider tokens with completion,
repair calls, output bytes, and latency. Keep warm/cold cache cells separate.
No new paid runs are part of this implementation.
