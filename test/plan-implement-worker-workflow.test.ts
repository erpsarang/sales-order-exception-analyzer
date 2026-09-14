import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan-implement-worker.yml", "utf8");

test("PLAN Worker는 pre-Bridge deterministic repair 단계를 포함한다", () => {
  assert.match(workflow, /timeout-minutes: 18/);
  assert.match(workflow, /deterministic CI 및 repair 입력 준비 0/);
  assert.match(workflow, /Untrusted bounded IMPLEMENT repair 1/);
  assert.match(workflow, /Untrusted bounded IMPLEMENT repair 2/);
  assert.match(workflow, /deterministic CI 최종 검증 2/);
  assert.match(workflow, /Validated candidate artifact 저장/);
});
