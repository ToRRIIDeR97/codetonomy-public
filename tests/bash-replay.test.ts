import assert from "node:assert/strict";
import test from "node:test";
import { replayBash, replayCases } from "../scripts/replay-bash.ts";
import { planBashCommand } from "../packages/tools/src/index.ts";

test("rg and shell-output regressions use native execution", () => {
  for (const entry of replayCases.filter(({ command }) => command.startsWith("rg"))) {
    assert.notEqual(planBashCommand(entry).route, "translated", entry.command);
  }
  for (const command of ["cat a b", "cat a | head -1", "ls | head -1", "rg absent src | head -1 && cat a"]) {
    assert.notEqual(planBashCommand({ command }).route, "translated", command);
  }
});

test("offline Bash replay agrees with native commands", async t => {
  const report = await replayBash();
  if (report.skipped) { t.skip(report.reason); return; }
  assert.deepEqual(report.rows.filter(row => !row.correct), []);
  assert.equal(report.rows.filter(row => row.repeatedRead).length, 1);
  assert.ok(report.rows.some(row => row.toolError));
  assert.ok(report.rows.every(row => row.indexedSearchUse === 0));
});
