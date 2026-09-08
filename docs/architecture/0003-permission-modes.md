# Permission modes and command sandbox

## Status

Accepted for implementation on 2026-08-14.

## Context

Codetonomy currently has one workspace-write permission profile whose mutations
require an approval handler. Its command sandbox grants only `:minimal` read
access, which hides user-installed toolchains and required system configuration.
This caused `npm test` to fail and triggered repeated model/tool rounds. Task
classification and verification then allowed the run to pass without a
successful requested command, while broad lexical skill routing injected an
unrelated skill.

The product is local and primarily single-user. macOS is the immediate target;
Linux and Windows must not regress. MemoryDB behavior is outside this change.

## Decision

Expose three user-facing permission modes while keeping authorization separate
from sandbox enforcement:

| Mode | Approval behavior | Command sandbox |
| --- | --- | --- |
| `ask` | Human approval for known `ASK` operations | Root read, workspace/temp write, network restricted |
| `auto` | Deterministic approval for known `ASK` operations | Same as `ask` |
| `full-access` | Deterministic approval for known tools | Unrestricted filesystem and network |

`DENY` and unknown tools remain denied in every mode. Environment filtering,
timeouts, cancellation, output limits, and checkpoints remain enabled. Full
access is session-scoped and resets to `ask` for a new session. Non-interactive
runs use `--permission-mode`; `--approve-writes` remains a deprecated alias for
`auto` during migration.

The workspace sandbox follows the proven Codex and Reasonix boundary: broad
reads so local toolchains work, confined writes, restricted network, and
targeted read denies for Codetonomy credentials and common user secret paths.

## Verification and recovery

- Explicit command requests such as `run npm test` require a matching command
  invocation with a zero exit code; an unrelated successful command does not
  satisfy verification.
- Fatal provider/runtime failures, recoverable tool-call failures, and unmet
  acceptance criteria are tracked separately; repair attempts cannot erase a
  fatal failure merely by starting another turn.
- A corrected tool call may resolve its own recoverable failure.
- Irrelevant skills must not activate from generic tokens such as `node`.

## Implementation sequence

1. Parameterize the permission gate and command sandbox with the selected mode.
2. Add CLI/TUI selection, display, reset behavior, and compatibility handling.
3. Correct command-intent compilation and verification state semantics.
4. Tighten automatic skill routing against generic-token false positives.
5. Add native toolchain, security-boundary, mode, compiler, verifier, and
   routing regression tests.
6. Run type checks, targeted tests, sandbox conformance, and the identical
   Codetonomy/Reasonix benchmark.

## Decision log

- Reuse the existing permission gate and Codex native sandbox.
- Treat approval policy and sandbox capability as independent controls.
- Keep `ask` as the default and reset full access on new sessions.
- Never make `auto` widen filesystem or network capability.
- Preserve explicit denies in all modes.
- Prefer broad read plus targeted deny over enumerating every local toolchain.

## Tool repair update — 2026-09-03

Final JSON must parse strictly before schema validation and permission checks.
Recoverable failures retain call identity and evidence-based resolution; optional
diagnostics can be superseded without being counted as repaired. Explicit file
and command obligations are checked separately, and prohibitions remain in force
through verifier correction.

Runs default to 100 model requests, 500 tool calls, and 30 minutes across repairs
and bounded child work. CLI overrides are `--max-model-turns`, `--max-tool-calls`,
and `--max-duration-ms`. Three equivalent failures without a relevant state
change stop that operation. Abort/deadline settles pending approval and prevents
late dispatch. Verifier feedback remains limited to two attempts.

An execution error can have effects. Uncertain file mutations require a
reconciliation read; arbitrary uncertain commands cannot be replayed automatically.
Command checkpoints report incomplete scope and residual coverage gaps. Captured
regular files and symlink entries can be restored only when current state still
matches the recorded post-state.

Causal repair metrics are versioned independently of historical verifier-attempt
tokens and duplicate-call rates. See the [implementation and validation report](../audits/tool-repair/implementation/README.md)
for tested guarantees and remaining platform/performance gates.
