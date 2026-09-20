import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ARTIFACT_NAME_PATTERNS,
  BOUNDS,
  GIT_SHA,
  HUMAN_COMMENTS,
  SHA256,
  WORKFLOWS,
  workflowByPath,
  type WorkflowKey,
} from "../src/self-improvement/lineage/index.js";
import { implementContractArtifactName } from "../src/self-improvement/implement-contract.js";
import { createPlanAuthorizeArtifact, planAuthorizeArtifactName } from "../src/self-improvement/plan-authorization.js";
import { PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH, planCandidateBridgeArtifactName } from "../src/self-improvement/plan-candidate-bridge.js";
import * as bridge from "../src/self-improvement/plan-candidate-bridge.js";
import * as handoff from "../src/self-improvement/plan-implement-handoff.js";
import * as worker from "../src/self-improvement/plan-implement-worker.js";
import * as recovery from "../src/self-improvement/plan-recovery.js";
import { ORCHESTRATOR_WORKFLOW_PATH } from "../src/self-improvement/orchestrator.js";
import { TRUSTED_RAIL_WORKFLOW_PATH } from "../src/self-improvement/seal.js";

const targetSha = "b".repeat(40);

function authorization() {
  return createPlanAuthorizeArtifact({
    normalizedPlan: {
      requirement: { issueNumber: 176, digest: "a".repeat(64) },
      repository: "erpsarang/sales-order-exception-analyzer",
      targetSha,
      plan: {
        runId: 34730034257,
        runAttempt: 1,
        artifact: { name: "plan-issue-176-34730034257-attempt-1", id: 10308609510, digest: "c".repeat(64) },
        provenanceArtifact: { name: "", id: 0, digest: "" },
      },
    },
    provenanceArtifact: { name: "plan-issue-176-34730034257-attempt-1-provenance", id: 10308699321, digest: "d".repeat(64) },
    currentRequirementDigest: "a".repeat(64),
    currentTargetSha: targetSha,
    approvalCommentId: 5649914569,
    approverUserId: 8370921,
    authorizationRunId: 34730287415,
    authorizationRunAttempt: 1,
  });
}

test("WORKFLOWS 상수는 기존 모듈이 각자 export한 path/name과 동일하다 (parity)", () => {
  assert.equal(WORKFLOWS.plan.path, handoff.PLAN_WORKFLOW_PATH);
  assert.equal(WORKFLOWS.plan.path, recovery.PLAN_WORKFLOW_PATH);
  assert.equal(WORKFLOWS.planAuthorize.path, handoff.PLAN_AUTHORIZE_WORKFLOW_PATH);
  assert.equal(WORKFLOWS.planImplementHandoff.name, worker.PLAN_IMPLEMENT_HANDOFF_WORKFLOW_NAME);
  assert.equal(WORKFLOWS.planImplementHandoff.path, worker.PLAN_IMPLEMENT_HANDOFF_WORKFLOW_PATH);
  assert.equal(WORKFLOWS.planImplementWorker.name, worker.PLAN_IMPLEMENT_WORKER_WORKFLOW_NAME);
  assert.equal(WORKFLOWS.planImplementWorker.name, bridge.PLAN_IMPLEMENT_WORKER_WORKFLOW_NAME);
  assert.equal(WORKFLOWS.planImplementWorker.path, worker.PLAN_IMPLEMENT_WORKER_WORKFLOW_PATH);
  assert.equal(WORKFLOWS.planImplementWorker.path, bridge.PLAN_IMPLEMENT_WORKER_WORKFLOW_PATH);
  assert.equal(WORKFLOWS.planCandidateBridge.path, PLAN_CANDIDATE_BRIDGE_WORKFLOW_PATH);
  assert.equal(WORKFLOWS.trustedRail.path, TRUSTED_RAIL_WORKFLOW_PATH);
  assert.equal(WORKFLOWS.orchestrator.path, ORCHESTRATOR_WORKFLOW_PATH);
});

test("WORKFLOWS 상수의 name은 실제 workflow 파일의 `name:`과 동일하다", () => {
  for (const key of Object.keys(WORKFLOWS) as WorkflowKey[]) {
    const { name, path } = WORKFLOWS[key];
    const yaml = readFileSync(path, "utf8");
    const match = /^name: (.+)$/m.exec(yaml);
    assert.ok(match, `${path} has a name`);
    assert.equal(match[1], name, `${key} workflow name`);
    assert.equal(workflowByPath(path), key);
  }
  assert.equal(workflowByPath(".github/workflows/does-not-exist.yml"), undefined);
});

test("BOUNDS는 기존 bounded 상수와 동일하다 (parity)", () => {
  assert.equal(BOUNDS.planImplementMaxFiles, handoff.PLAN_IMPLEMENT_MAX_FILES);
  assert.equal(BOUNDS.planImplementMaxContextBytes, handoff.PLAN_IMPLEMENT_MAX_CONTEXT_BYTES);
  assert.equal(BOUNDS.planImplementMaxPatchBytes, handoff.PLAN_IMPLEMENT_MAX_PATCH_BYTES);
  assert.equal(BOUNDS.planRebindMaxDriftFiles, handoff.PLAN_REBIND_MAX_DRIFT_FILES);
  assert.equal(BOUNDS.maxAutoReplanPerAuthorization, recovery.MAX_AUTO_REPLAN_PER_AUTHORIZATION);
});

test("SHA/digest 정규식은 기존 모듈과 같은 입력을 같은 결과로 판정한다", () => {
  for (const value of ["a".repeat(40), "f".repeat(64), "A".repeat(40), "a".repeat(39), "g".repeat(40), ""]) {
    assert.equal(GIT_SHA.test(value), /^[0-9a-f]{40,64}$/.test(value), `GIT_SHA ${JSON.stringify(value)}`);
    assert.equal(SHA256.test(value), /^[0-9a-f]{64}$/.test(value), `SHA256 ${JSON.stringify(value)}`);
  }
});

test("HUMAN_COMMENTS는 workflow가 exact match하는 comment 본문과 동일하다", () => {
  const authorize = readFileSync(".github/workflows/plan-authorize.yml", "utf8");
  const handoffYaml = readFileSync(".github/workflows/plan-implement-handoff.yml", "utf8");
  assert.ok(authorize.includes(`github.event.comment.body == '${HUMAN_COMMENTS.planApproval}'`));
  assert.ok(handoffYaml.includes(`github.event.comment.body == '${HUMAN_COMMENTS.planRebind}'`));
});

test("ARTIFACT_NAME_PATTERNS는 기존 builder 출력과 exact match한다 (parity)", () => {
  const approved = authorization();
  assert.match(approved.plan.artifact.name, ARTIFACT_NAME_PATTERNS.plan);
  assert.match(approved.plan.provenanceArtifact.name, ARTIFACT_NAME_PATTERNS.planProvenance);
  assert.doesNotMatch(approved.plan.provenanceArtifact.name, ARTIFACT_NAME_PATTERNS.plan);
  assert.match(planAuthorizeArtifactName(approved), ARTIFACT_NAME_PATTERNS.planAuthorize);
  assert.match(implementContractArtifactName(approved), ARTIFACT_NAME_PATTERNS.implementContract);
  assert.match(handoff.planImplementHandoffArtifactName(approved), ARTIFACT_NAME_PATTERNS.planImplementHandoff);
  assert.match(worker.workerAiCallLedgerArtifactName("e".repeat(64)), ARTIFACT_NAME_PATTERNS.workerAiCallLedger);
  assert.match(
    planCandidateBridgeArtifactName({ issueNumber: 176, workerRunId: 1, workerRunAttempt: 2, bridgeRunId: 3, bridgeRunAttempt: 4 }),
    ARTIFACT_NAME_PATTERNS.planBridgeCandidate,
  );
  // worker candidate 이름은 bundle이 필요하므로 builder 문자열 형식만 고정한다.
  const workerName = [
    "bounded-worker-candidate",
    `issue-${approved.requirement.issueNumber}`,
    `plan-${approved.plan.runId}`,
    `approval-${approved.approval.commentId}`,
    "handoff-11-attempt-1",
    "worker-22-attempt-1",
  ].join("-");
  const parsed = ARTIFACT_NAME_PATTERNS.workerCandidate.exec(workerName);
  assert.ok(parsed);
  assert.deepEqual(parsed.slice(1).map(Number), [176, approved.plan.runId, approved.approval.commentId, 11, 1, 22, 1]);
  assert.match("worker-recovery-ready-issue-176-run-9-attempt-1", ARTIFACT_NAME_PATTERNS.workerRecoveryReady);
});

test("ARTIFACT_NAME_PATTERNS는 workflow 파일 안의 정규식과 같은 이름을 받아들인다", () => {
  const bridgeYaml = readFileSync(".github/workflows/plan-candidate-bridge.yml", "utf8");
  const workerYaml = readFileSync(".github/workflows/plan-implement-worker.yml", "utf8");
  assert.ok(workerYaml.includes("/^plan-implement-handoff-issue-\\d+-plan-\\d+-attempt-\\d+-approval-\\d+$/"));
  assert.ok(workerYaml.includes("/^plan-implement-handoff-issue-(\\d+)-plan-\\d+-attempt-\\d+-approval-\\d+$/"));
  assert.ok(bridgeYaml.includes("^bounded-worker-candidate-issue-\\\\d+-plan-\\\\d+-approval-\\\\d+-handoff-(\\\\d+)-attempt-(\\\\d+)-worker-"));
  assert.ok(bridgeYaml.includes("^plan-bridge-candidate-issue-\\\\d+-worker-\\\\d+-attempt-\\\\d+-bridge-"));
});
