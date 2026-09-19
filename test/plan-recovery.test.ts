import assert from "node:assert/strict";
import test from "node:test";
import { createPlanAuthorizeArtifact } from "../src/self-improvement/plan-authorization.js";
import {
  classifyPlanRecovery,
  type PlanRunObservation,
} from "../src/self-improvement/plan-recovery.js";

const targetSha = "a".repeat(40);

function authorization() {
  return createPlanAuthorizeArtifact({
    normalizedPlan: {
      requirement: { issueNumber: 57, digest: "b".repeat(64) },
      repository: "erpsarang/sales-order-exception-analyzer",
      targetSha,
      plan: {
        runId: 35419847754,
        runAttempt: 2,
        artifact: {
          name: "plan-issue-57-35419847754-attempt-2",
          id: 10577623562,
          digest: "c".repeat(64),
        },
        provenanceArtifact: { name: "", id: 0, digest: "" },
      },
    },
    provenanceArtifact: {
      name: "plan-issue-57-35419847754-attempt-2-provenance",
      id: 10577897979,
      digest: "d".repeat(64),
    },
    currentRequirementDigest: "b".repeat(64),
    currentTargetSha: targetSha,
    approvalCommentId: 5739393840,
    approverUserId: 8370921,
    authorizationRunId: 35421839292,
    authorizationRunAttempt: 1,
  });
}

function planRun(overrides: Partial<PlanRunObservation> = {}): PlanRunObservation {
  return {
    name: "Read-only AI PLAN",
    path: ".github/workflows/plan.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    runAttempt: 2,
    headBranch: "main",
    headSha: targetSha,
    ...overrides,
  };
}

test("exact PLAN identity와 current default가 같으면 recovery가 필요 없다", () => {
  assert.deepEqual(
    classifyPlanRecovery(authorization(), planRun(), "main", targetSha),
    { required: false, reason: "NONE" },
  );
});

test("default branch가 승인 target 이후 이동하면 fresh PLAN recovery를 요구한다", () => {
  assert.deepEqual(
    classifyPlanRecovery(authorization(), planRun(), "main", "e".repeat(40)),
    { required: true, reason: "DEFAULT_BRANCH_MOVED" },
  );
});

test("PLAN workflow control-plane SHA가 targetSha와 다르면 fresh PLAN recovery를 요구한다", () => {
  assert.deepEqual(
    classifyPlanRecovery(
      authorization(),
      planRun({ headSha: "f".repeat(40) }),
      "main",
      targetSha,
    ),
    { required: true, reason: "PLAN_CONTROL_PLANE_STALE" },
  );
});

test("workflow identity 이상은 자동 recovery하지 않고 fail-closed 한다", () => {
  const approved = authorization();
  assert.throws(
    () => classifyPlanRecovery(approved, planRun({ path: ".github/workflows/other.yml" }), "main", targetSha),
    /identity is invalid/,
  );
  assert.throws(
    () => classifyPlanRecovery(approved, planRun({ runAttempt: 3 }), "main", targetSha),
    /identity is invalid/,
  );
  assert.throws(
    () => classifyPlanRecovery(approved, planRun({ conclusion: "failure" }), "main", targetSha),
    /identity is invalid/,
  );
  assert.throws(
    () => classifyPlanRecovery(approved, planRun({ headBranch: "feature" }), "main", targetSha),
    /identity is invalid/,
  );
});
