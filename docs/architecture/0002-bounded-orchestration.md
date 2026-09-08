# ADR 0002: Bounded orchestration and write claims

Codetonomy adapts the behavior of Reasonix's scheduler, write-claim, and fleet
graph packages at pinned commit `63dae234b27fdf28b0661239bfbaa61ab14435af`.
The Go implementation was not copied because its mutex/context machinery and
agent runtime types cannot be isolated inside the TypeScript control plane
without a larger sidecar than the contract itself.

The harness-owned implementation keeps the externally testable invariants:
three depth-one children maximum, two parallel writers, no permission or preset
expansion, fail-before-start DAG validation, symlink-safe normalized write
claims, concurrent overlap rejection, downstream skip on failure, and synthesis
from verified children only. No Reasonix source is copied or modified.
