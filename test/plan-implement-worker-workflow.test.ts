import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PLAN_IMPLEMENT_CODEX_ACTION_PIN,
  PLAN_IMPLEMENT_CODEX_ARGS,
  PLAN_IMPLEMENT_CODEX_EFFORT,
  PLAN_IMPLEMENT_CODEX_MODEL,
} from "../src/self-improvement/plan-implement-worker.js";

const workflow = readFileSync(".github/workflows/plan-implement-worker.yml", "utf8");
const workerPolicySource = readFileSync("src/self-improvement/plan-implement-worker.ts", "utf8");

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


test("PLAN Worker는 INFRA_FAILURE를 exact stalled marker로 기록한다", () => {
  assert.match(workflow, /source_run_id: \$\{\{ steps\.source\.outputs\.run_id \}\}/);
  assert.match(workflow, /source_run_attempt: \$\{\{ steps\.source\.outputs\.run_attempt \}\}/);
  assert.match(workflow, /\n      issues: write\n/);
  assert.match(workflow, /name: INFRA_FAILURE stalled cycle 기록/);
  assert.match(workflow, /ai-dev-framework:STALLED_WORKER issue=/);
  assert.match(workflow, /handoff-run=/);
  assert.match(workflow, /handoff-attempt=/);
  assert.match(workflow, /base-sha=/);
  assert.match(workflow, /reason=INFRA_FAILURE/);
  assert.match(workflow, /exact STALLED_WORKER marker already exists/);
  assert.match(workflow, /Trusted Recovery Preflight가 PASS하면 Worker가 자동 재진입합니다/);
});

test("RECOVERY_READY는 exact provenance 검증 후 기존 Handoff source로 Worker에 자동 재진입한다", () => {
  assert.match(workflow, /Trusted PLAN IMPLEMENT Handoff.*,.*Trusted Worker Recovery Preflight/);
  assert.match(workflow, /name: RECOVERY_READY artifact 다운로드/);
  assert.match(workflow, /name: RECOVERY_READY artifact 다운로드[\s\S]*run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(workflow, /kind === 'trusted-worker-recovery-ready'/);
  assert.match(workflow, /preflight\?\.workflowPath === '\.github\/workflows\/plan-worker-recovery-preflight\.yml'/);
  assert.match(workflow, /recovery\.preflight\?\.runId === run\.id/);
  assert.match(workflow, /branch\.commit\.sha === run\.head_sha/);
  assert.match(workflow, /recovery_kind', 'trusted-recovery-compare-v1'/);
  assert.match(workflow, /RECOVERY_GUARD_KIND:/);
  assert.match(workflow, /run-id: \$\{\{ steps\.source\.outputs\.run_id \}\}/);
  assert.match(workflow, /run-id: \$\{\{ needs\.attempt0\.outputs\.source_run_id \}\}/);
  assert.match(workflow, /run-id: \$\{\{ needs\.attempt0_result\.outputs\.source_run_id \}\}/);
});


test("bounded IMPLEMENT 계열은 Terra + low로 고정하고 AI_CALL_ID에 model identity를 포함한다", () => {
  assert.equal((workflow.match(/model: gpt-5\.6-terra/g) ?? []).length, 4);
  assert.equal((workflow.match(/effort: low/g) ?? []).length, 4);
  assert.ok(workflow.includes(`model: ${PLAN_IMPLEMENT_CODEX_MODEL}`));
  assert.ok(workflow.includes(`effort: ${PLAN_IMPLEMENT_CODEX_EFFORT}`));
  assert.match(workerPolicySource, /model: PLAN_IMPLEMENT_CODEX_MODEL/);
  assert.doesNotMatch(workflow, /model: gpt-6-astra/);
});

test("동일 direct PASS bounded IMPLEMENT는 ledger로 Codex 재호출을 차단한다", () => {
  assert.ok(workflow.includes(`uses: openai/codex-action@${PLAN_IMPLEMENT_CODEX_ACTION_PIN}`));
  assert.ok(workflow.includes(`effort: ${PLAN_IMPLEMENT_CODEX_EFFORT}`));
  assert.ok(workflow.includes(`codex-args: '${PLAN_IMPLEMENT_CODEX_ARGS}'`));
  assert.match(workflow, /ai_call_id: \$\{\{ steps\.prepare\.outputs\.ai_call_id \}\}/);
  assert.match(workflow, /reused: \$\{\{ steps\.prepare\.outputs\.reuse_candidate \}\}/);
  assert.match(workflow, /name: 동일 AI call 성공 candidate 다운로드/);
  assert.match(workflow, /name: 재사용 candidate trusted rebind/);
  assert.match(workflow, /plan-implement-worker-handler\.ts reuse/);
  assert.match(
    workflow,
    /name: Untrusted bounded IMPLEMENT Worker[\s\S]*if: steps\.source\.outputs\.should_run == 'true' && steps\.prepare\.outputs\.reuse_candidate != 'true'/,
  );
  assert.match(workflow, /CANDIDATE_OUTPUT_DIRECTORY: \$\{\{ runner\.temp \}\}\/validated-candidate-0/);
  assert.match(workflow, /name: deterministic CI 및 repair 입력 준비 0/);
  assert.match(workflow, /name: direct PASS AI call ledger 생성/);
  assert.match(workflow, /needs\.attempt0_result\.outputs\.ci_status == 'PASS'/);
  assert.match(workflow, /needs\.attempt0_result\.outputs\.reused != 'true'/);
  assert.match(workflow, /needs\.attempt0_result\.outputs\.retry_required != 'true'/);
  assert.match(workflow, /name: bounded-worker-ai-call-\$\{\{ needs\.attempt0_result\.outputs\.ai_call_id \}\}/);

  const repair1 = workflow.slice(workflow.indexOf("\n  repair1:\n"), workflow.indexOf("\n  repair2:\n"));
  const repair2 = workflow.slice(workflow.indexOf("\n  repair2:\n"), workflow.indexOf("\n  finalize:\n"));
  assert.doesNotMatch(repair1, /reuse_candidate/);
  assert.doesNotMatch(repair2, /reuse_candidate/);
});
