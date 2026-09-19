import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan-implement-worker.yml", "utf8");

test("PLAN Worker는 fresh Job 기반 pre-Bridge bounded repair를 포함한다", () => {
  assert.match(workflow, /\n  attempt0:\n/);
  assert.match(workflow, /\n  timeout_retry:\n/);
  assert.match(workflow, /\n  attempt0_result:\n/);
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
  assert.match(workflow, /needs\.attempt0_result\.outputs\.repair_ready == 'true'/);
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
  assert.match(workflow, /retry_required: \$\{\{ steps\.timeout0\.outputs\.retry \}\}/);
  assert.match(workflow, /name: Trusted timeout retry input 저장/);

  const attempt0Start = workflow.indexOf("\n  attempt0:\n");
  const retryStart = workflow.indexOf("\n  timeout_retry:\n");
  const resultStart = workflow.indexOf("\n  attempt0_result:\n");
  const repairStart = workflow.indexOf("\n  repair1:\n");
  assert.ok(attempt0Start >= 0 && retryStart > attempt0Start && resultStart > retryStart && repairStart > resultStart);

  const attempt0 = workflow.slice(attempt0Start, retryStart);
  const timeoutRetry = workflow.slice(retryStart, resultStart);
  const normalized = workflow.slice(resultStart, repairStart);

  assert.doesNotMatch(attempt0, /Untrusted bounded IMPLEMENT timeout retry/);
  assert.match(timeoutRetry, /needs: attempt0/);
  assert.match(timeoutRetry, /needs\.attempt0\.outputs\.retry_required == 'true'/);
  assert.match(timeoutRetry, /runs-on: ubuntu-latest/);
  assert.match(timeoutRetry, /Trusted timeout retry input 다운로드/);
  assert.match(timeoutRetry, /name: Untrusted bounded IMPLEMENT timeout retry/);
  assert.match(timeoutRetry, /timeout-minutes: 6/);
  assert.match(timeoutRetry, /safety-strategy: drop-sudo/);
  assert.match(timeoutRetry, /worker-codex-home-timeout-retry/);
  assert.equal((workflow.match(/name: Untrusted bounded IMPLEMENT timeout retry/g) ?? []).length, 1);

  assert.match(normalized, /needs: \[attempt0, timeout_retry\]/);
  assert.match(normalized, /fresh-runner timeout retry failed before trusted attempt 0 state was produced/);
  assert.match(workflow, /repair1:[\s\S]*needs: \[attempt0, attempt0_result\]/);
  assert.match(workflow, /needs\.attempt0_result\.outputs\.ci_status == 'FAIL'/);
});
