import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  ".github/workflows/plan-worker-recovery-preflight.yml",
  "utf8",
);

test("Recovery Preflight는 명시적 Issue 하나만 입력받고 AI를 호출하지 않는다", () => {
  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      issue_number:/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /issues: read/);
  assert.doesNotMatch(workflow, /openai\/codex-action|CODEX_API_KEY/);
  assert.doesNotMatch(workflow, /createWorkflowDispatch|pulls\.merge|git\s+push/);
});

test("Recovery Preflight는 STALLED_WORKER와 failed Worker/Handoff exact identity를 검증한다", () => {
  assert.match(workflow, /ai-dev-framework:STALLED_WORKER issue=/);
  assert.match(workflow, /expected at least one STALLED_WORKER marker/);
  assert.match(workflow, /expected exactly one STALLED Handoff cycle/);
  assert.match(workflow, /createdAt: comment\.created_at/);
  assert.match(workflow, /selected latest STALLED_WORKER marker/);
  assert.match(workflow, /PLAN Bounded IMPLEMENT Worker/);
  assert.match(workflow, /worker\.conclusion !== 'failure'/);
  assert.match(workflow, /baseToWorker/);
  assert.match(workflow, /workerToCurrent/);
  assert.match(workflow, /outside approved-base ancestry/);
  assert.match(workflow, /not an ancestor of current default/);
  assert.doesNotMatch(workflow, /worker\.head_sha !== source\.baseSha/);
  assert.match(workflow, /Trusted PLAN IMPLEMENT Handoff/);
  assert.match(workflow, /handoff\.conclusion !== 'success'/);
  assert.match(workflow, /expected one exact Handoff artifact/);
  assert.match(workflow, /artifact\.name === source\.handoffArtifactName/);
  assert.match(workflow, /artifact\.digest/);
});

test("Recovery Preflight는 Handoff source event로 workflow_run과 issue_comment(rebind) 두 값만 허용한다", () => {
  assert.match(workflow, /!\['workflow_run', 'issue_comment'\]\.includes\(handoff\.event\) \|\|/);
  assert.doesNotMatch(workflow, /handoff\.event !== 'workflow_run'/);
  // Handoff event를 다루는 곳은 allowlist 한 곳뿐이고, 다른 비교/우회가 없다.
  assert.equal((workflow.match(/handoff\.event/g) ?? []).length, 1);
  const literal = /!\[([^\]]+)\]\.includes\(handoff\.event\)/.exec(workflow);
  assert.ok(literal);
  const allowed = literal[1]!.split(",").map((item) => item.trim().replace(/^'(.*)'$/, "$1"));
  assert.deepEqual(allowed, ["workflow_run", "issue_comment"]);
  for (const event of ["push", "issues", "workflow_dispatch", "pull_request", "schedule", ""]) {
    assert.equal(allowed.includes(event), false, event);
  }
});

test("issue_comment Handoff 허용은 event 집합만 넓힐 뿐 나머지 Handoff identity 검증은 그대로다", () => {
  const start = workflow.indexOf("handoff.name !== 'Trusted PLAN IMPLEMENT Handoff'");
  const end = workflow.indexOf("STALLED_WORKER source Handoff identity mismatch");
  assert.ok(start > 0 && end > start);
  const block = workflow.slice(start, end);
  const expectedConditions = [
    "handoff.name !== 'Trusted PLAN IMPLEMENT Handoff' ||",
    "handoff.path !== '.github/workflows/plan-implement-handoff.yml' ||",
    "!['workflow_run', 'issue_comment'].includes(handoff.event) ||",
    "handoff.status !== 'completed' ||",
    "handoff.conclusion !== 'success' ||",
    "handoff.run_attempt !== source.handoffRunAttempt ||",
    "handoff.head_branch !== defaultBranch ||",
    "handoff.head_sha !== source.baseSha",
  ];
  const actual = block.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("handoff.") || line.startsWith("!["));
  assert.deepEqual(actual, expectedConditions);
  // 실패 시 fail-closed (setFailed + return)
  assert.match(workflow, /core\.setFailed\('STALLED_WORKER source Handoff identity mismatch'\);\n\s+return;/);
});

test("failed Worker 검증은 Handoff event 변경의 영향을 받지 않는다", () => {
  const start = workflow.indexOf("worker.name !== 'PLAN Bounded IMPLEMENT Worker'");
  const end = workflow.indexOf("STALLED_WORKER source Worker identity mismatch");
  assert.ok(start > 0 && end > start);
  const actual = workflow.slice(start, end).split("\n").map((line) => line.trim()).filter((line) => line.startsWith("worker.") || line.startsWith("!/"));
  assert.deepEqual(actual, [
    "worker.name !== 'PLAN Bounded IMPLEMENT Worker' ||",
    "worker.path !== '.github/workflows/plan-implement-worker.yml' ||",
    "worker.event !== 'workflow_run' ||",
    "worker.status !== 'completed' ||",
    "worker.conclusion !== 'failure' ||",
    "worker.run_attempt !== source.workerRunAttempt ||",
    "worker.head_branch !== defaultBranch ||",
    "!/^[0-9a-f]{40,64}$/.test(worker.head_sha || '')",
  ]);
});

test("Recovery Preflight는 #75 approved base 이후 명시된 Framework recovery 파일 drift만 허용한다", () => {
  assert.match(workflow, /compareCommitsWithBasehead/);
  assert.match(workflow, /comparison\.merge_base_commit\.sha !== source\.baseSha/);
  assert.match(workflow, /files\.length > 12/);
  assert.match(workflow, /'\.github\/workflows\/plan-implement-worker\.yml'/);
  assert.match(workflow, /'\.github\/workflows\/plan-candidate-bridge\.yml'/);
  assert.match(workflow, /'test\/plan-implement-worker-workflow\.test\.ts'/);
  assert.match(workflow, /'test\/plan-candidate-bridge-workflow\.test\.ts'/);
  assert.match(workflow, /'test\/plan-candidate-bridge\.test\.ts'/);
  assert.match(workflow, /'\.github\/workflows\/plan-worker-recovery-preflight\.yml'/);
  assert.match(workflow, /'src\/self-improvement\/plan-implement-worker-handler\.ts'/);
  assert.match(workflow, /'src\/self-improvement\/plan-implement-worker\.ts'/);
  assert.match(workflow, /'src\/self-improvement\/plan-candidate-bridge-handler\.ts'/);
  assert.match(workflow, /'src\/self-improvement\/plan-candidate-bridge\.ts'/);
  assert.match(workflow, /'test\/plan-implement-worker\.test\.ts'/);
  assert.match(workflow, /'test\/plan-worker-recovery-preflight-workflow\.test\.ts'/);
  assert.match(workflow, /!\['added', 'modified'\]\.includes\(file\.status\)/);
  assert.match(workflow, /recovery requires fresh PLAN; non-approved drift/);
});

test("검증 성공 시 provenance가 포함된 RECOVERY_READY artifact만 만든다", () => {
  assert.match(workflow, /kind: 'trusted-worker-recovery-ready'/);
  assert.match(workflow, /sourceMarkerCommentId/);
  assert.match(workflow, /approvedBaseSha/);
  assert.match(workflow, /currentDefaultSha/);
  assert.match(workflow, /sourceHandoff:/);
  assert.match(workflow, /failedWorker:/);
  assert.match(workflow, /trustedCodeSha: context\.sha/);
  assert.match(workflow, /worker-recovery-ready-issue-/);
  assert.match(workflow, /RECOVERY_READY artifact 저장/);
});
