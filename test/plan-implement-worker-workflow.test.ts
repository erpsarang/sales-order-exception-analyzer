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

  const repair1 = workflow.slice(workflow.indexOf("\n  repair1:\n"), workflow.indexOf("\n  repair2:\n"));
  const repair2 = workflow.slice(workflow.indexOf("\n  repair2:\n"), workflow.indexOf("\n  finalize:\n"));
  assert.match(repair1, /if: >-\n\s+always\(\) &&\n\s+needs\.attempt0_result\.outputs\.ci_status == 'FAIL'/);
  assert.match(repair2, /if: >-\n\s+always\(\) &&\n\s+needs\.repair1\.outputs\.ci_status == 'FAIL'/);
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


test("bounded IMPLEMENT timeout retry usage는 raw proposal 보존 뒤 trusted same-job에서 수집한다", () => {
  const retry = workflow.slice(workflow.indexOf("\n  timeout_retry:\n"), workflow.indexOf("\n  attempt0_result:\n"));
  const rawIndex = retry.indexOf("timeout retry raw proposal artifact 저장");
  const checkoutIndex = retry.indexOf("Trusted validation checkout retry");
  const usageIndex = retry.indexOf("CODEX_HOME persisted bounded IMPLEMENT timeout retry usage exact 기록");
  const usageArtifactIndex = retry.indexOf("trusted bounded IMPLEMENT timeout retry usage artifact 저장");
  const cleanupIndex = retry.indexOf("timeout retry CODEX_HOME 제거");
  const candidateValidationIndex = retry.indexOf("Trusted candidate 검증 retry");

  assert.ok(rawIndex >= 0);
  assert.ok(checkoutIndex > rawIndex);
  assert.ok(usageIndex > checkoutIndex);
  assert.ok(usageArtifactIndex > usageIndex);
  assert.ok(cleanupIndex > usageArtifactIndex);
  assert.ok(candidateValidationIndex > cleanupIndex);

  assert.match(retry, /bounded-worker-raw-proposal-timeout-retry-/);
  assert.match(retry, /working-directory: control-validate-retry[\s\S]*ai-usage-rollout-handler\.ts/);
  assert.match(retry, /CODEX_HOME_PATH: \$\{\{ runner\.temp \}\}\/worker-codex-home-timeout-retry/);
  assert.match(retry, /AI_USAGE_STAGE: bounded-implement-timeout-retry/);
  assert.match(retry, /AI_USAGE_JOB_NAME: timeout_retry/);
  assert.match(retry, /bounded-implement-usage\/timeout-retry\.json/);
  assert.doesNotMatch(retry, /actions\/jobs\/.*\/logs/);

  const inputCleanup = retry.slice(
    retry.indexOf("      - name: timeout retry input 제거"),
    retry.indexOf("      - name: Trusted validation checkout retry"),
  );
  assert.doesNotMatch(inputCleanup, /worker-codex-home-timeout-retry/);
});

test("bounded IMPLEMENT timeout retry 실패는 usage 관찰 뒤 명시적으로 fail-closed한다", () => {
  const retry = workflow.slice(workflow.indexOf("\n  timeout_retry:\n"), workflow.indexOf("\n  attempt0_result:\n"));
  const actionIndex = retry.indexOf("Untrusted bounded IMPLEMENT timeout retry");
  const checkoutIndex = retry.indexOf("Trusted validation checkout retry");
  const observeIndex = retry.indexOf("CODEX_HOME persisted bounded IMPLEMENT timeout retry failure usage 관찰");
  const recordedIndex = retry.indexOf("trusted bounded IMPLEMENT timeout retry failure usage artifact 저장");
  const unavailableIndex = retry.indexOf("trusted bounded IMPLEMENT timeout retry failure usage unavailable observation 저장");
  const cleanupIndex = retry.indexOf("timeout retry CODEX_HOME 제거");
  const gateIndex = retry.indexOf("timeout retry 실행 결과 확인");
  const candidateIndex = retry.indexOf("Trusted candidate 검증 retry");

  assert.ok(actionIndex >= 0);
  assert.ok(checkoutIndex > actionIndex);
  assert.ok(observeIndex > checkoutIndex);
  assert.ok(recordedIndex > observeIndex);
  assert.ok(unavailableIndex > recordedIndex);
  assert.ok(cleanupIndex > unavailableIndex);
  assert.ok(gateIndex > cleanupIndex);
  assert.ok(candidateIndex > gateIndex);

  assert.match(retry, /id: implement_retry[\s\S]*continue-on-error: true[\s\S]*timeout-minutes: 6/);
  assert.match(retry, /timeout retry raw proposal artifact 저장[\s\S]*if: steps\.implement_retry\.outcome == 'success'/);
  assert.match(retry, /CODEX_HOME persisted bounded IMPLEMENT timeout retry usage exact 기록[\s\S]*if: steps\.implement_retry\.outcome == 'success'/);
  assert.match(retry, /CODEX_HOME persisted bounded IMPLEMENT timeout retry failure usage 관찰[\s\S]*if: steps\.implement_retry\.outcome == 'failure'/);
  assert.match(retry, /ai-usage-timeout-observation-handler\.ts/);
  assert.match(retry, /AI_USAGE_STAGE: bounded-implement-timeout-retry/);
  assert.match(retry, /AI_USAGE_JOB_NAME: timeout_retry/);
  assert.match(retry, /bounded-implement-usage-observation\/timeout-retry-failure\.json/);
  assert.match(retry, /RETRY_OUTCOME: \$\{\{ steps\.implement_retry\.outcome \}\}/);
  assert.match(retry, /bounded IMPLEMENT timeout retry failed after usage observation/);
  assert.doesNotMatch(retry, /actions\/jobs\/.*\/logs/);
});

test("bounded IMPLEMENT attempt0 timeout은 job 종료 전에 persisted usage 또는 unavailable 증거를 남긴다", () => {
  const attempt0 = workflow.slice(workflow.indexOf("\n  attempt0:\n"), workflow.indexOf("\n  timeout_retry:\n"));
  const retryInputIndex = attempt0.indexOf("timeout retry input artifact 저장");
  const checkoutIndex = attempt0.indexOf("Trusted attempt0 timeout usage checkout");
  const observeIndex = attempt0.indexOf("CODEX_HOME persisted bounded IMPLEMENT attempt0 timeout usage 관찰");
  const recordedIndex = attempt0.indexOf("trusted bounded IMPLEMENT attempt0 timeout usage artifact 저장");
  const unavailableIndex = attempt0.indexOf("trusted bounded IMPLEMENT attempt0 timeout usage unavailable observation 저장");
  const cleanupIndex = attempt0.indexOf("attempt0 timeout CODEX_HOME 제거");

  assert.ok(retryInputIndex >= 0);
  assert.ok(checkoutIndex > retryInputIndex);
  assert.ok(observeIndex > checkoutIndex);
  assert.ok(recordedIndex > observeIndex);
  assert.ok(unavailableIndex > recordedIndex);
  assert.ok(cleanupIndex > unavailableIndex);

  assert.match(attempt0, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}[\s\S]*path: control-timeout-usage-0/);
  assert.match(attempt0, /working-directory: control-timeout-usage-0[\s\S]*ai-usage-timeout-observation-handler\.ts/);
  assert.match(attempt0, /CODEX_HOME_PATH: \$\{\{ runner\.temp \}\}\/worker-codex-home/);
  assert.match(attempt0, /AI_USAGE_STAGE: bounded-implement-attempt0/);
  assert.match(attempt0, /AI_USAGE_JOB_NAME: attempt0/);
  assert.match(attempt0, /steps\.timeout_usage0\.outputs\.status == 'recorded'/);
  assert.match(attempt0, /steps\.timeout_usage0\.outputs\.status == 'unavailable'/);
  assert.match(attempt0, /bounded-implement-usage-observation\/attempt0-timeout\.json/);
  assert.doesNotMatch(attempt0, /actions\/jobs\/.*\/logs/);
});

test("bounded IMPLEMENT attempt0 usage는 raw proposal 보존 뒤 trusted same-job에서 수집한다", () => {
  const attempt0 = workflow.slice(workflow.indexOf("\n  attempt0:\n"), workflow.indexOf("\n  timeout_retry:\n"));
  const rawIndex = attempt0.indexOf("attempt0 raw proposal artifact 저장");
  const checkoutIndex = attempt0.indexOf("Trusted validation checkout 0");
  const usageIndex = attempt0.indexOf("CODEX_HOME persisted bounded IMPLEMENT attempt0 usage exact 기록");
  const usageArtifactIndex = attempt0.indexOf("trusted bounded IMPLEMENT attempt0 usage artifact 저장");
  const cleanupIndex = attempt0.indexOf("attempt0 CODEX_HOME 제거");
  const candidateValidationIndex = attempt0.indexOf("Trusted candidate 검증 0");

  assert.ok(rawIndex >= 0);
  assert.ok(checkoutIndex > rawIndex);
  assert.ok(usageIndex > checkoutIndex);
  assert.ok(usageArtifactIndex > usageIndex);
  assert.ok(cleanupIndex > usageArtifactIndex);
  assert.ok(candidateValidationIndex > cleanupIndex);

  assert.match(attempt0, /bounded-worker-raw-proposal-attempt0-/);
  assert.match(attempt0, /working-directory: control-validate-0[\s\S]*ai-usage-rollout-handler\.ts/);
  assert.match(attempt0, /CODEX_HOME_PATH: \$\{\{ runner\.temp \}\}\/worker-codex-home/);
  assert.match(attempt0, /AI_USAGE_STAGE: bounded-implement-attempt0/);
  assert.match(attempt0, /AI_USAGE_JOB_NAME: attempt0/);
  assert.match(attempt0, /bounded-implement-usage\/attempt0\.json/);
  assert.doesNotMatch(attempt0, /actions\/jobs\/.*\/logs/);

  const inputCleanup = attempt0.slice(
    attempt0.indexOf("      - name: Worker input 제거"),
    attempt0.indexOf("      - name: Trusted validation checkout 0"),
  );
  assert.doesNotMatch(inputCleanup, /worker-codex-home/);
});

test("bounded IMPLEMENT repair1 실패는 usage 관찰 뒤 명시적으로 fail-closed한다", () => {
  const repair1 = workflow.slice(workflow.indexOf("\n  repair1:\n"), workflow.indexOf("\n  repair2:\n"));
  const actionIndex = repair1.indexOf("Untrusted bounded IMPLEMENT repair 1");
  const checkoutIndex = repair1.indexOf("Trusted validation checkout 1");
  const observeIndex = repair1.indexOf("CODEX_HOME persisted bounded IMPLEMENT repair1 failure usage 관찰");
  const recordedIndex = repair1.indexOf("trusted bounded IMPLEMENT repair1 failure usage artifact 저장");
  const unavailableIndex = repair1.indexOf("trusted bounded IMPLEMENT repair1 failure usage unavailable observation 저장");
  const cleanupIndex = repair1.indexOf("repair1 CODEX_HOME 제거");
  const gateIndex = repair1.indexOf("repair1 실행 결과 확인");
  const candidateIndex = repair1.indexOf("Trusted candidate 검증 1");

  assert.ok(actionIndex >= 0);
  assert.ok(checkoutIndex > actionIndex);
  assert.ok(observeIndex > checkoutIndex);
  assert.ok(recordedIndex > observeIndex);
  assert.ok(unavailableIndex > recordedIndex);
  assert.ok(cleanupIndex > unavailableIndex);
  assert.ok(gateIndex > cleanupIndex);
  assert.ok(candidateIndex > gateIndex);

  assert.match(repair1, /id: implement_repair1[\s\S]*continue-on-error: true[\s\S]*timeout-minutes: 4/);
  assert.match(repair1, /repair 1 raw proposal artifact 저장[\s\S]*if: steps\.implement_repair1\.outcome == 'success'/);
  assert.match(repair1, /CODEX_HOME persisted bounded IMPLEMENT repair1 usage exact 기록[\s\S]*if: steps\.implement_repair1\.outcome == 'success'/);
  assert.match(repair1, /CODEX_HOME persisted bounded IMPLEMENT repair1 failure usage 관찰[\s\S]*if: steps\.implement_repair1\.outcome == 'failure'/);
  assert.match(repair1, /ai-usage-timeout-observation-handler\.ts/);
  assert.match(repair1, /AI_USAGE_STAGE: bounded-implement-repair1/);
  assert.match(repair1, /AI_USAGE_JOB_NAME: repair1/);
  assert.match(repair1, /bounded-implement-usage-observation\/repair1-failure\.json/);
  assert.match(repair1, /REPAIR1_OUTCOME: \$\{\{ steps\.implement_repair1\.outcome \}\}/);
  assert.match(repair1, /bounded IMPLEMENT repair1 failed after usage observation/);
  assert.doesNotMatch(repair1, /actions\/jobs\/.*\/logs/);
});

test("bounded IMPLEMENT repair1 usage는 raw proposal 보존 뒤 trusted same-job에서 수집한다", () => {
  const repair1 = workflow.slice(workflow.indexOf("\n  repair1:\n"), workflow.indexOf("\n  repair2:\n"));
  const rawIndex = repair1.indexOf("repair 1 raw proposal artifact 저장");
  const checkoutIndex = repair1.indexOf("Trusted validation checkout 1");
  const usageIndex = repair1.indexOf("CODEX_HOME persisted bounded IMPLEMENT repair1 usage exact 기록");
  const usageArtifactIndex = repair1.indexOf("trusted bounded IMPLEMENT repair1 usage artifact 저장");
  const cleanupIndex = repair1.indexOf("repair1 CODEX_HOME 제거");
  const candidateValidationIndex = repair1.indexOf("Trusted candidate 검증 1");

  assert.ok(rawIndex >= 0);
  assert.ok(checkoutIndex > rawIndex);
  assert.ok(usageIndex > checkoutIndex);
  assert.ok(usageArtifactIndex > usageIndex);
  assert.ok(cleanupIndex > usageArtifactIndex);
  assert.ok(candidateValidationIndex > cleanupIndex);

  assert.match(repair1, /bounded-worker-raw-proposal-repair1-/);
  assert.match(repair1, /working-directory: control-validate-1[\s\S]*ai-usage-rollout-handler\.ts/);
  assert.match(repair1, /CODEX_HOME_PATH: \$\{\{ runner\.temp \}\}\/worker-codex-home-repair-1/);
  assert.match(repair1, /AI_USAGE_STAGE: bounded-implement-repair1/);
  assert.match(repair1, /AI_USAGE_JOB_NAME: repair1/);
  assert.match(repair1, /bounded-implement-usage\/repair1\.json/);
  assert.doesNotMatch(repair1, /actions\/jobs\/.*\/logs/);

  const inputCleanup = repair1.slice(
    repair1.indexOf("      - name: repair 1 input 제거"),
    repair1.indexOf("      - name: Trusted validation checkout 1"),
  );
  assert.doesNotMatch(inputCleanup, /worker-codex-home-repair-1/);
});

test("bounded IMPLEMENT repair2 실패는 usage 관찰 뒤 명시적으로 fail-closed한다", () => {
  const repair2 = workflow.slice(workflow.indexOf("\n  repair2:\n"), workflow.indexOf("\n  finalize:\n"));
  const actionIndex = repair2.indexOf("Untrusted bounded IMPLEMENT repair 2");
  const checkoutIndex = repair2.indexOf("Trusted validation checkout 2");
  const observeIndex = repair2.indexOf("CODEX_HOME persisted bounded IMPLEMENT repair2 failure usage 관찰");
  const recordedIndex = repair2.indexOf("trusted bounded IMPLEMENT repair2 failure usage artifact 저장");
  const unavailableIndex = repair2.indexOf("trusted bounded IMPLEMENT repair2 failure usage unavailable observation 저장");
  const cleanupIndex = repair2.indexOf("repair2 CODEX_HOME 제거");
  const gateIndex = repair2.indexOf("repair2 실행 결과 확인");
  const candidateIndex = repair2.indexOf("Trusted candidate 검증 2");

  assert.ok(actionIndex >= 0);
  assert.ok(checkoutIndex > actionIndex);
  assert.ok(observeIndex > checkoutIndex);
  assert.ok(recordedIndex > observeIndex);
  assert.ok(unavailableIndex > recordedIndex);
  assert.ok(cleanupIndex > unavailableIndex);
  assert.ok(gateIndex > cleanupIndex);
  assert.ok(candidateIndex > gateIndex);

  assert.match(repair2, /id: implement_repair2[\s\S]*continue-on-error: true[\s\S]*timeout-minutes: 4/);
  assert.match(repair2, /repair 2 raw proposal artifact 저장[\s\S]*if: steps\.implement_repair2\.outcome == 'success'/);
  assert.match(repair2, /CODEX_HOME persisted bounded IMPLEMENT repair2 usage exact 기록[\s\S]*if: steps\.implement_repair2\.outcome == 'success'/);
  assert.match(repair2, /CODEX_HOME persisted bounded IMPLEMENT repair2 failure usage 관찰[\s\S]*if: steps\.implement_repair2\.outcome == 'failure'/);
  assert.match(repair2, /ai-usage-timeout-observation-handler\.ts/);
  assert.match(repair2, /AI_USAGE_STAGE: bounded-implement-repair2/);
  assert.match(repair2, /AI_USAGE_JOB_NAME: repair2/);
  assert.match(repair2, /bounded-implement-usage-observation\/repair2-failure\.json/);
  assert.match(repair2, /REPAIR2_OUTCOME: \$\{\{ steps\.implement_repair2\.outcome \}\}/);
  assert.match(repair2, /bounded IMPLEMENT repair2 failed after usage observation/);
  assert.doesNotMatch(repair2, /actions\/jobs\/.*\/logs/);
});

test("bounded IMPLEMENT repair2 usage는 raw proposal 보존 뒤 trusted same-job에서 수집한다", () => {
  const repair2 = workflow.slice(workflow.indexOf("\n  repair2:\n"), workflow.indexOf("\n  finalize:\n"));
  const rawIndex = repair2.indexOf("repair 2 raw proposal artifact 저장");
  const checkoutIndex = repair2.indexOf("Trusted validation checkout 2");
  const usageIndex = repair2.indexOf("CODEX_HOME persisted bounded IMPLEMENT repair2 usage exact 기록");
  const usageArtifactIndex = repair2.indexOf("trusted bounded IMPLEMENT repair2 usage artifact 저장");
  const cleanupIndex = repair2.indexOf("repair2 CODEX_HOME 제거");
  const candidateValidationIndex = repair2.indexOf("Trusted candidate 검증 2");

  assert.ok(rawIndex >= 0);
  assert.ok(checkoutIndex > rawIndex);
  assert.ok(usageIndex > checkoutIndex);
  assert.ok(usageArtifactIndex > usageIndex);
  assert.ok(cleanupIndex > usageArtifactIndex);
  assert.ok(candidateValidationIndex > cleanupIndex);

  assert.match(repair2, /bounded-worker-raw-proposal-repair2-/);
  assert.match(repair2, /working-directory: control-validate-2[\s\S]*ai-usage-rollout-handler\.ts/);
  assert.match(repair2, /CODEX_HOME_PATH: \$\{\{ runner\.temp \}\}\/worker-codex-home-repair-2/);
  assert.match(repair2, /AI_USAGE_STAGE: bounded-implement-repair2/);
  assert.match(repair2, /AI_USAGE_JOB_NAME: repair2/);
  assert.match(repair2, /bounded-implement-usage\/repair2\.json/);
  assert.doesNotMatch(repair2, /actions\/jobs\/.*\/logs/);

  const inputCleanup = repair2.slice(
    repair2.indexOf("      - name: repair 2 input 제거"),
    repair2.indexOf("      - name: Trusted validation checkout 2"),
  );
  assert.doesNotMatch(inputCleanup, /worker-codex-home-repair-2/);
});

test("finalize는 bounded IMPLEMENT recorded usage만 trusted summary로 합산한다", () => {
  const finalize = workflow.slice(workflow.indexOf("\n  finalize:\n"));

  assert.match(finalize, /\n      contents: read\n/);
  assert.match(finalize, /name: bounded IMPLEMENT recorded usage summary 입력 준비/);
  assert.match(
    finalize,
    /pattern: ai-usage-bounded-implement-\*-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(finalize, /merge-multiple: true/);
  assert.match(finalize, /name: Trusted recorded usage summary checkout/);
  assert.match(finalize, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(finalize, /working-directory: control-usage-summary[\s\S]*ai-usage-summary-handler\.ts/);
  assert.match(finalize, /AI_USAGE_SUMMARY_DIRECTORY: \$\{\{ runner\.temp \}\}\/bounded-implement-usage-records/);
  assert.match(finalize, /AI_USAGE_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(finalize, /AI_USAGE_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(finalize, /trusted bounded IMPLEMENT recorded usage summary artifact 저장/);
  assert.match(finalize, /steps\.usage_summary\.outputs\.artifact_name/);
  assert.doesNotMatch(finalize, /AI_USAGE_BUDGET|TOKEN_BUDGET|MAX_TOTAL_TOKENS/);
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

test("Trusted PLAN rebind Handoff의 issue_comment source를 downstream에서 허용한다", () => {
  assert.match(workflow, /!\['workflow_run', 'issue_comment'\]\.includes\(run\.event\)/);
  assert.match(workerPolicySource, /expectedEvent = bundle\.rebind \? "issue_comment" : "workflow_run"/);
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
