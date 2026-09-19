import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const requestWorkflow = await readFile(".github/workflows/fix-request.yml", "utf8");
const workerWorkflow = await readFile(".github/workflows/fix-worker.yml", "utf8");
const trustedRail = await readFile(".github/workflows/trusted-rail.yml", "utf8");
const fixHandler = await readFile("src/self-improvement/fix-handler.ts", "utf8");

const requestJob = requestWorkflow.split("\n  dispatch_worker:\n")[0] ?? "";
const requestDispatch = requestWorkflow.split("\n  dispatch_worker:\n")[1] ?? "";
const workerPrepare = (workerWorkflow.split("\n  prepare:\n")[1] ?? "").split("\n  worker:\n")[0] ?? "";
const workerJob = (workerWorkflow.split("\n  worker:\n")[1] ?? "").split("\n  validate:\n")[0] ?? "";
const workerValidation = (workerWorkflow.split("\n  validate:\n")[1] ?? "").split("\n  record:\n")[0] ?? "";
const workerRecord = (workerWorkflow.split("\n  record:\n")[1] ?? "").split("\n  dispatch_trusted_rail:\n")[0] ?? "";
const railDispatch = workerWorkflow.split("\n  dispatch_trusted_rail:\n")[1] ?? "";
const railSeal = trustedRail.split("\n  publish:\n")[0] ?? "";

test("Trusted FIX Request는 workflow_run 연쇄 대신 FIX Worker를 explicit workflow_dispatch 한다", () => {
  assert.match(requestWorkflow, /workflow_dispatch:/);
  assert.match(requestDispatch, /permissions:\n      actions: write/);
  assert.doesNotMatch(requestDispatch, /contents: write|pull-requests: write|issues: write/);
  assert.match(requestDispatch, /createWorkflowDispatch/);
  assert.match(requestDispatch, /workflow_id: 'fix-worker\.yml'/);
  assert.match(requestDispatch, /source_fix_request_run_id/);
  assert.match(requestDispatch, /source_fix_request_run_attempt/);
  assert.match(requestDispatch, /source_fix_request_artifact_name/);
});

test("FIX Worker dispatch는 GitHub Actions의 명시적 run id/attempt를 exact identity로 사용한다", () => {
  assert.match(requestDispatch, /CURRENT_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(requestDispatch, /CURRENT_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(requestDispatch, /const currentRunId = Number\(process\.env\.CURRENT_RUN_ID\)/);
  assert.match(requestDispatch, /const currentRunAttempt = Number\(process\.env\.CURRENT_RUN_ATTEMPT\)/);
  assert.match(requestDispatch, /source_fix_request_run_id: String\(currentRunId\)/);
  assert.match(requestDispatch, /source_fix_request_run_attempt: String\(currentRunAttempt\)/);
  assert.doesNotMatch(requestDispatch, /context\.runAttempt/);
});

test("FIX Request trusted job은 source Trusted Rail completion과 exact REVIEW artifact를 기다려 검증한다", () => {
  assert.match(requestJob, /permissions:\n      contents: read\n      actions: read/);
  assert.doesNotMatch(requestJob, /contents: write|pull-requests: write|issues: write/);
  assert.match(requestJob, /sourceRun\.status === 'completed'/);
  assert.match(requestJob, /sourceRun\.conclusion !== 'success'/);
  assert.match(requestJob, /sourceRun\.path !== '\.github\/workflows\/trusted-rail\.yml'/);
  assert.match(requestJob, /sourceRun\?\.event === 'workflow_run' \|\| sourceRun\?\.event === 'workflow_dispatch'/);
  assert.match(requestJob, /expected exactly one source REVIEW artifact/);
});

test("FIX Request는 source REVIEW 이후 Framework-only drift만 bounded recovery로 허용한다", () => {
  assert.match(requestJob, /currentBranch\.commit\.sha !== context\.sha/);
  assert.ok(requestJob.includes("basehead: `${sourceRun.head_sha}...${context.sha}`"));
  assert.match(requestJob, /drift\.merge_base_commit\.sha !== sourceRun\.head_sha/);
  assert.match(requestJob, /driftFiles\.length > 14/);
  assert.match(requestJob, /allowedFrameworkDrift = new Set/);
  assert.match(requestJob, /'\.github\/workflows\/fix-request\.yml'/);
  assert.match(requestJob, /'src\/self-improvement\/plan-implement-worker-handler\.ts'/);
  assert.match(requestJob, /'test\/fix-dispatch-workflow\.test\.ts'/);
  assert.match(requestJob, /FIX recovery requires fresh PLAN; non-approved drift/);
  assert.doesNotMatch(requestJob, /allowedFrameworkDrift\.has\([^)]*\.startsWith/);
});

test("전용 FIX Worker는 explicit dispatch 입력만 받고 global 권한은 비어 있다", () => {
  assert.match(workerWorkflow, /name: Untrusted FIX Worker/);
  assert.match(workerWorkflow, /workflow_dispatch:/);
  assert.match(workerWorkflow, /source_fix_request_run_id:/);
  assert.match(workerWorkflow, /source_fix_request_run_attempt:/);
  assert.match(workerWorkflow, /source_fix_request_artifact_name:/);
  assert.match(workerWorkflow, /permissions: \{\}/);
  assert.doesNotMatch(workerWorkflow, /workflow_run:/);
});

test("FIX prepare는 source request가 completed success인지 확인하고 exact artifact만 사용한다", () => {
  assert.match(workerPrepare, /sourceRun\.status === 'completed'/);
  assert.match(workerPrepare, /sourceRun\.conclusion !== 'success'/);
  assert.match(workerPrepare, /sourceRun\.path !== '\.github\/workflows\/fix-request\.yml'/);
  assert.match(workerPrepare, /sourceRun\.event !== 'workflow_dispatch'/);
  assert.match(workerPrepare, /sourceRun\.run_attempt !== runAttempt/);
  assert.match(workerPrepare, /expected exactly one FIX request artifact/);
  assert.match(workerPrepare, /FIX request\/review 재검증 및 prompt 생성/);
  assert.match(workerPrepare, /FIX base HEAD mismatch/);
});

test("FIX Worker는 과거 Request provenance와 현재 trusted code SHA를 분리한다", () => {
  assert.match(workerPrepare, /currentBranch\.commit\.sha !== context\.sha/);
  assert.ok(workerPrepare.includes("basehead: `${sourceRun.head_sha}...${context.sha}`"));
  assert.match(workerPrepare, /drift\.merge_base_commit\.sha !== sourceRun\.head_sha/);
  assert.match(workerPrepare, /driftFiles\.length > 6/);
  assert.match(workerPrepare, /allowedFrameworkDrift = new Set/);
  assert.match(workerPrepare, /'\.github\/workflows\/fix-worker\.yml'/);
  assert.match(workerPrepare, /'src\/self-improvement\/fix-handler\.ts'/);
  assert.match(workerPrepare, /'test\/fix-dispatch-workflow\.test\.ts'/);
  assert.match(workerPrepare, /FIX Worker recovery requires fresh FIX Request; non-approved drift/);
  assert.match(workerPrepare, /core\.setOutput\('head_sha', sourceRun\.head_sha\)/);
  assert.match(workerPrepare, /core\.setOutput\('trusted_code_sha', context\.sha\)/);
  assert.match(workerPrepare, /ref: \$\{\{ steps\.source\.outputs\.trusted_code_sha \}\}/);
  assert.match(workerWorkflow, /source_control_plane_sha: \$\{\{ steps\.source\.outputs\.trusted_code_sha \}\}/);
  assert.match(workerWorkflow, /source_request_control_plane_sha: \$\{\{ steps\.source\.outputs\.head_sha \}\}/);
  assert.match(workerRecord, /SOURCE_FIX_REQUEST_CONTROL_PLANE_SHA: \$\{\{ needs\.prepare\.outputs\.source_request_control_plane_sha \}\}/);
});

test("untrusted FIX Worker에는 write credential과 push/Merge 경로가 없다", () => {
  assert.match(workerJob, /permissions:\n      contents: read\n      actions: read/);
  assert.match(workerJob, /GITHUB_TOKEN: ""/);
  assert.match(workerJob, /GH_TOKEN: ""/);
  assert.match(workerJob, /persist-credentials: false/);
  assert.match(workerJob, /uses: openai\/codex-action@v1/);
  assert.match(workerJob, /permission-profile: ":workspace"/);
  assert.doesNotMatch(workerJob, /contents: write|pull-requests: write|issues: write|git push|gh pr|mergePullRequest/);
});

test("FIX Worker는 Terra + no reasoning을 명시 고정한다", () => {
  assert.match(workerJob, /model: gpt-5\.6-terra/);
  assert.match(workerJob, /effort: none/);
  assert.doesNotMatch(workerJob, /model: gpt-6-astra/);
});

test("FIX usage는 snapshot 보존 뒤 exact trusted control-plane에서 same-job 수집한다", () => {
  assert.match(workerJob, /codex-home: \$\{\{ runner\.temp \}\}\/fix-codex-home/);

  const snapshotIndex = workerJob.indexOf("untrusted FIX workspace snapshot 저장");
  const usageCheckoutIndex = workerJob.indexOf("exact trusted usage control-plane checkout");
  const usageParseIndex = workerJob.indexOf("CODEX_HOME persisted FIX usage exact 기록");
  assert.ok(snapshotIndex >= 0);
  assert.ok(usageCheckoutIndex > snapshotIndex);
  assert.ok(usageParseIndex > usageCheckoutIndex);

  assert.match(workerJob, /ref: \$\{\{ needs\.prepare\.outputs\.source_control_plane_sha \}\}/);
  assert.match(workerJob, /path: usage-control/);
  assert.match(workerJob, /token: \$\{\{ github\.token \}\}/);
  assert.match(workerJob, /working-directory: usage-control/);
  assert.match(workerJob, /ai-usage-rollout-handler\.ts/);
  assert.match(workerJob, /CODEX_HOME_PATH: \$\{\{ runner\.temp \}\}\/fix-codex-home/);
  assert.match(workerJob, /AI_USAGE_STAGE: fix/);
  assert.match(workerJob, /AI_USAGE_JOB_NAME: worker/);
  assert.match(workerJob, /fix-usage\/fix-usage\.json/);
  assert.match(workerJob, /trusted FIX usage artifact 저장/);

  assert.doesNotMatch(workerJob, /actions\/jobs\/.*\/logs/);
  assert.doesNotMatch(workerJob, /path: \$\{\{ runner\.temp \}\}\/fix-codex-home/);
});

test("untrusted FIX Codex는 github-actions[bot]만 exact allowlist하고 전체 bot 허용은 금지한다", () => {
  assert.match(workerJob, /allow-bot-users: "github-actions\[bot\]"/);
  assert.doesNotMatch(workerJob, /allow-bots:\s*true/);
});

test("FIX Worker는 Codex 전에 dependency를 준비하고 로컬 test/build를 명시한다", () => {
  assert.match(workerJob, /npm ci --ignore-scripts/);
  assert.match(fixHandler, /패키지 재설치를 시도하지 마세요/);
  assert.match(fixHandler, /npm test와 npm run build를 실행/);
});

test("FIX candidate는 fresh trusted runner의 deterministic validation을 통과해야 한다", () => {
  assert.match(workerValidation, /permissions:\n      contents: read\n      actions: read/);
  assert.match(workerValidation, /ref: \$\{\{ needs\.prepare\.outputs\.reviewed_head_sha \}\}/);
  assert.match(workerValidation, /fix-workspace-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workerValidation, /npm ci/);
  assert.match(workerValidation, /npm test/);
  assert.match(workerValidation, /npm run build/);
  assert.match(workerValidation, /git diff --check/);
  assert.doesNotMatch(workerValidation, /openai\/codex-action|contents: write|actions: write/);
  assert.match(workerRecord, /needs: \[prepare, worker, validate\]/);
  assert.match(workerRecord, /needs\.validate\.result == 'success'/);
});

test("FIX candidate provenance 기록은 fresh trusted runner의 read-only job에서 수행한다", () => {
  assert.match(workerRecord, /permissions:\n      contents: read\n      actions: read/);
  assert.doesNotMatch(workerRecord, /contents: write|pull-requests: write|issues: write/);
  assert.match(workerRecord, /exact reviewed SHA fetch 및 FIX candidate patch 생성/);
  assert.match(workerRecord, /fix-handler\.ts finalize/);
  assert.match(workerRecord, /implement-candidate-/);
  assert.match(workerRecord, /candidate\.patch/);
  assert.match(workerRecord, /implement\.json/);
});

test("candidate 기록 성공 뒤 actions:write 전용 job만 Trusted Rail을 explicit dispatch 한다", () => {
  assert.match(railDispatch, /needs: record/);
  assert.match(railDispatch, /permissions:\n      actions: write/);
  assert.doesNotMatch(railDispatch, /contents: write|pull-requests: write|issues: write/);
  assert.match(railDispatch, /createWorkflowDispatch/);
  assert.match(railDispatch, /workflow_id: 'trusted-rail\.yml'/);
  assert.match(railDispatch, /source_candidate_run_id/);
  assert.match(railDispatch, /source_candidate_run_attempt/);
  assert.match(railDispatch, /source_candidate_artifact_name/);
});

test("Trusted Rail dispatch도 명시적 FIX Worker run id/attempt를 exact identity로 사용한다", () => {
  assert.match(railDispatch, /CURRENT_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(railDispatch, /CURRENT_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(railDispatch, /const currentRunId = Number\(process\.env\.CURRENT_RUN_ID\)/);
  assert.match(railDispatch, /const currentRunAttempt = Number\(process\.env\.CURRENT_RUN_ATTEMPT\)/);
  assert.match(railDispatch, /source_candidate_run_id: String\(currentRunId\)/);
  assert.match(railDispatch, /source_candidate_run_attempt: String\(currentRunAttempt\)/);
  assert.doesNotMatch(railDispatch, /context\.runAttempt/);
});

test("Trusted Rail explicit entry는 FIX Worker completion과 exact candidate identity를 fail-closed 검증한다", () => {
  assert.match(trustedRail, /workflow_dispatch:/);
  assert.match(railSeal, /context\.eventName === 'workflow_dispatch'/);
  assert.match(railSeal, /run\.status !== 'completed'/);
  assert.match(railSeal, /run\.conclusion !== 'success'/);
  assert.match(railSeal, /const expectedPath = sourceKind === 'PLAN_BRIDGE'/);
  assert.match(railSeal, /: '\.github\/workflows\/fix-worker\.yml';/);
  assert.match(railSeal, /run\.path !== expectedPath/);
  assert.match(railSeal, /const expectedEvents = sourceKind === 'PLAN_BRIDGE'/);
  assert.match(railSeal, /: new Set\(\['workflow_dispatch'\]\);/);
  assert.match(railSeal, /!expectedEvents\.has\(run\.event\)/);
  assert.match(railSeal, /expected exactly one explicit \$\{sourceKind\} candidate artifact/);
  assert.match(railSeal, /SOURCE_RUN_ID: \$\{\{ steps\.candidate_artifact\.outputs\.source_run_id \}\}/);
});
