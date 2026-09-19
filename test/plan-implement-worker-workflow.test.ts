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
  assert.match(workflow, /repair_ready: \${\{ steps\.ci0\.outputs\.repair_ready \}\}/);
  assert.match(workflow, /needs\.attempt0\.outputs\.repair_ready == 'true'/);
  assert.match(workflow, /needs\.repair1\.outputs\.repair_ready == 'true'/);
  assert.match(workflow, /out-of-scope boundary repair 차단 시 fail-closed/);
  assert.match(workflow, /AI repair blocked by deterministic repair policy/);
  assert.match(workflow, /Validated candidate artifact 저장/);
});


test("PLAN Worker는 timeout 경계 failure만 fresh runner에서 1회 bounded 자동 재시도한다", () => {
  assert.match(workflow, /name: IMPLEMENT timeout 측정 시작/);
  assert.match(workflow, /id: implement0[\s\S]*continue-on-error: true[\s\S]*timeout-minutes: 4/);
  assert.match(workflow, /name: IMPLEMENT timeout 재시도 분류/);
  assert.match(workflow, /\[ "\$elapsed" -ge 230 \]/);
  assert.match(workflow, /\[ "\$has_output" = "false" \]/);
  assert.match(workflow, /\n  timeout_retry:\n[\s\S]*needs: attempt0[\s\S]*runs-on: ubuntu-latest/);
  assert.match(workflow, /name: timeout retry input artifact 저장/);
  assert.match(workflow, /name: timeout retry input artifact 다운로드/);
  assert.match(workflow, /name: Untrusted bounded IMPLEMENT timeout retry[\s\S]*timeout-minutes: 6/);
  assert.match(workflow, /\n  attempt0_result:\n[\s\S]*initial\/retry effective 결과 고정/);
  assert.match(workflow, /needs: attempt0_result/);
  assert.match(workflow, /needs: \[attempt0_result, repair1\]/);
  assert.match(workflow, /needs: \[attempt0_result, repair1, repair2\]/);
  assert.match(workflow, /infrastructure_failed/);
  assert.equal((workflow.match(/name: Untrusted bounded IMPLEMENT timeout retry/g) ?? []).length, 1);

  const attempt0 = workflow.slice(workflow.indexOf("\n  attempt0:\n"), workflow.indexOf("\n  timeout_retry:\n"));
  assert.equal((attempt0.match(/uses: openai\/codex-action@/g) ?? []).length, 1);
  assert.doesNotMatch(attempt0, /name: Untrusted bounded IMPLEMENT timeout retry/);
});
