import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  createLineageRoot,
  createStageProvenance,
  effectiveBase,
  lineageDigestOf,
  verifyLineageChain,
  verifyLineageRoot,
  verifyStageProvenance,
  WORKFLOWS,
  type LineageRoot,
  type StageProvenance,
} from "../src/self-improvement/lineage/index.js";
import { createPlanAuthorizeArtifact } from "../src/self-improvement/plan-authorization.js";

const targetSha = "b".repeat(40);
const reboundSha = "9".repeat(40);

function approved() {
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

function root(rebind?: { sourceTargetSha: string; reboundTargetSha: string; rebindDigest: string }): LineageRoot {
  const auth = approved();
  const base = effectiveBase(auth, rebind);
  return createLineageRoot({
    repository: auth.repository,
    issueNumber: auth.requirement.issueNumber,
    requirementDigest: auth.requirement.digest,
    plan: {
      runId: auth.plan.runId,
      runAttempt: auth.plan.runAttempt,
      targetSha: auth.targetSha,
      artifact: auth.plan.artifact,
      provenanceArtifact: auth.plan.provenanceArtifact,
    },
    approval: {
      commentId: auth.approval.commentId,
      approverUserId: auth.approval.approverUserId,
      authorizationDigest: auth.authorizationDigest,
    },
    base: { sha: base.sha, kind: base.kind, ...(rebind ? { rebindDigest: rebind.rebindDigest } : {}) },
  });
}

function handoffStage(r: LineageRoot): StageProvenance {
  return createStageProvenance({
    root: r,
    stage: "handoff",
    trigger: "UPSTREAM_COMPLETION",
    producer: { workflowPath: WORKFLOWS.planImplementHandoff.path, runId: 100, runAttempt: 1, controlPlaneSha: r.base.sha },
    subject: { artifact: { name: "plan-implement-handoff-issue-176-plan-34730034257-attempt-1-approval-5649914569", id: 1, digest: "1".repeat(64) }, digests: { contractDigest: "2".repeat(64), contextDigest: "3".repeat(64), handoffDigest: "4".repeat(64) } },
  });
}

test("canonicalJson은 키 순서와 undefined에 독립적이다", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(lineageDigestOf({ b: 1, a: 2 }), lineageDigestOf({ a: 2, b: 1 }));
});

test("root: APPROVED base는 plan.targetSha와 같아야 하고 rebindDigest를 가질 수 없다", () => {
  const r = root();
  assert.equal(r.base.kind, "APPROVED");
  assert.equal(r.base.sha, targetSha);
  assert.deepEqual(verifyLineageRoot(r), r);
  assert.throws(() => verifyLineageRoot({ ...r, base: { ...r.base, sha: reboundSha } }), /APPROVED base must equal/);
  assert.throws(() => verifyLineageRoot({ ...r, base: { ...r.base, rebindDigest: "e".repeat(64) } }), /must not carry rebindDigest/);
});

test("root: REBOUND base는 plan.targetSha와 달라야 하고 rebindDigest가 필요하다", () => {
  const r = root({ sourceTargetSha: targetSha, reboundTargetSha: reboundSha, rebindDigest: "e".repeat(64) });
  assert.equal(r.base.kind, "REBOUND");
  assert.equal(r.base.sha, reboundSha);
  assert.equal(r.base.rebindDigest, "e".repeat(64));
  assert.throws(() => verifyLineageRoot({ ...r, base: { sha: reboundSha, kind: "REBOUND" } }), /rebindDigest/);
  assert.throws(() => verifyLineageRoot({ ...r, base: { ...r.base, sha: targetSha } }), /must differ/);
});

test("root: 변조, 추가 필드, digest 불일치는 fail-closed", () => {
  const r = root();
  assert.throws(() => verifyLineageRoot({ ...r, issueNumber: 177 }), /digest mismatch/);
  assert.throws(() => verifyLineageRoot({ ...r, extra: true }), /unexpected fields/);
  assert.throws(() => verifyLineageRoot({ ...r, rootDigest: "0".repeat(64) }), /digest mismatch/);
  assert.throws(() => verifyLineageRoot({ ...r, kind: "execution-lineage-stage" }), /unsupported lineage root schema/);
  assert.throws(() => verifyLineageRoot(null), /unsupported/);
});

test("stage: 첫 stage는 parent=rootDigest, 이후는 parent=직전 lineageDigest", () => {
  const r = root();
  const handoff = handoffStage(r);
  assert.equal(handoff.parentLineageDigest, r.rootDigest);
  assert.equal(handoff.rootDigest, r.rootDigest);

  const worker = createStageProvenance({
    root: r,
    parent: handoff,
    stage: "worker",
    trigger: "UPSTREAM_COMPLETION",
    producer: { workflowPath: WORKFLOWS.planImplementWorker.path, runId: 200, runAttempt: 1, controlPlaneSha: targetSha },
    subject: { digests: { candidateDigest: "5".repeat(64) } },
  });
  assert.equal(worker.parentLineageDigest, handoff.lineageDigest);
  assert.deepEqual(verifyStageProvenance(worker, { root: r, parent: handoff }), worker);
  assert.deepEqual(verifyLineageChain(r, [handoff, worker]).stages.map((s) => s.stage), ["handoff", "worker"]);
});

test("stage: 순서 위반, root 불일치, parent 불일치, 변조는 fail-closed", () => {
  const r = root();
  const other = root({ sourceTargetSha: targetSha, reboundTargetSha: reboundSha, rebindDigest: "e".repeat(64) });
  const handoff = handoffStage(r);
  const producer = { workflowPath: WORKFLOWS.planCandidateBridge.path, runId: 300, runAttempt: 1, controlPlaneSha: targetSha };

  assert.throws(
    () => createStageProvenance({ root: r, parent: handoff, stage: "bridge", trigger: "UPSTREAM_COMPLETION", producer, subject: { digests: {} } }),
    /stage order violation: handoff -> bridge/,
  );
  assert.throws(
    () => createStageProvenance({ root: other, parent: handoff, stage: "worker", trigger: "UPSTREAM_COMPLETION", producer, subject: { digests: {} } }),
    /does not belong to the given lineage root/,
  );
  assert.throws(() => verifyStageProvenance({ ...handoff, trigger: "REBIND_REQUEST" }, { root: r }), /digest mismatch/);
  assert.throws(() => verifyStageProvenance({ ...handoff, extra: 1 }, { root: r }), /unexpected fields/);
  assert.throws(() => verifyStageProvenance({ ...handoff, parentLineageDigest: "0".repeat(64) }, { root: r }), /first stage must reference the root/);
  assert.throws(() => verifyLineageChain(r, [handoff, handoff]), /parent digest mismatch/);
  assert.throws(
    () => verifyStageProvenance(handoff, { root: r, parent: handoff }),
    /parent digest mismatch|stage order violation/,
  );
});

test("stage: retry/repair는 같은 parent를 가리키는 형제 record로 표현된다 (fan-out)", () => {
  const r = root();
  const handoff = handoffStage(r);
  const attempt = (runAttempt: number) => createStageProvenance({
    root: r,
    parent: handoff,
    stage: "worker",
    trigger: "UPSTREAM_COMPLETION",
    producer: { workflowPath: WORKFLOWS.planImplementWorker.path, runId: 200, runAttempt, controlPlaneSha: targetSha },
    subject: { digests: { candidateDigest: runAttempt === 1 ? "5".repeat(64) : "6".repeat(64) } },
  });
  const a1 = attempt(1);
  const a2 = attempt(2);
  assert.equal(a1.parentLineageDigest, a2.parentLineageDigest);
  assert.notEqual(a1.lineageDigest, a2.lineageDigest);
  assert.doesNotThrow(() => verifyLineageChain(r, [handoff, a1]));
  assert.doesNotThrow(() => verifyLineageChain(r, [handoff, a2]));
});

test("stage: subject.digests 값과 producer 필드는 형식 검증된다", () => {
  const r = root();
  const producer = { workflowPath: WORKFLOWS.planImplementHandoff.path, runId: 1, runAttempt: 1, controlPlaneSha: targetSha };
  assert.throws(
    () => createStageProvenance({ root: r, stage: "handoff", trigger: "UPSTREAM_COMPLETION", producer, subject: { digests: { x: "nope" } } }),
    /subject\.digests\.x/,
  );
  assert.throws(
    () => createStageProvenance({ root: r, stage: "handoff", trigger: "UPSTREAM_COMPLETION", producer: { ...producer, controlPlaneSha: "bad" }, subject: { digests: {} } }),
    /controlPlaneSha/,
  );
  assert.throws(
    () => createStageProvenance({ root: r, stage: "handoff", trigger: "UPSTREAM_COMPLETION", producer: { ...producer, runId: 0 }, subject: { digests: {} } }),
    /producer\.runId/,
  );
});
