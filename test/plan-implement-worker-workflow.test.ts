import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan-implement-worker.yml", "utf8");

test("PLAN Worker는 fresh Job 기반 pre-Bridge bounded repair를 포함한다", () => {
  assert.match(workflow, /\n  attempt0:\n/);
  assert.match(workflow, /\n  repair1:\n/);
  assert.match(workflow, /\n  repair2:\n/);
  assert.match(workflow, /\n  finalize:\n/);
  assert.match(workflow, /bounded-worker-state-0-/);
  assert.match(workflow, /bounded-worker-state-1-/);
  assert.match(workflow, /bounded-worker-state-2-/);
  assert.match(workflow, /Untrusted bounded IMPLEMENT repair 1/);
  assert.match(workflow, /Untrusted bounded IMPLEMENT repair 2/);
  assert.match(workflow, /bounded repair 소진 시 fail-closed/);
  assert.match(workflow, /Validated candidate artifact 저장/);
});
