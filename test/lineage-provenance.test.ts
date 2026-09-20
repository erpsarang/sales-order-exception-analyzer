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

// ---------------------------------------------------------------------------
// runtime fail-closed: 외부 JSON은 TypeScript type을 믿지 않는다
// ---------------------------------------------------------------------------

/** 공격자가 필드를 바꾼 뒤 digest까지 다시 계산해 맞춘 record를 만든다. */
function forge(stage: StageProvenance, patch: Record<string, unknown>): Record<string, unknown> {
  const { digestAlgorithm: _algorithm, lineageDigest: _digest, ...payload } = { ...stage, ...patch } as Record<string, unknown>;
  return { ...payload, digestAlgorithm: "sha256", lineageDigest: lineageDigestOf(payload) };
}

test("forge helper 자체는 유효한 record를 그대로 재현한다 (테스트 전제 확인)", () => {
  const r = root();
  const handoff = handoffStage(r);
  assert.deepEqual(forge(handoff, {}), handoff);
  assert.doesNotThrow(() => verifyStageProvenance(forge(handoff, {}), { root: r }));
});

test("stage: 알 수 없는 stage/trigger는 digest를 다시 계산해도 거부된다", () => {
  const r = root();
  const handoff = handoffStage(r);
  assert.throws(() => verifyStageProvenance(forge(handoff, { stage: "merge" }), { root: r }), /not a known LineageStage/);
  assert.throws(() => verifyStageProvenance(forge(handoff, { stage: 7 }), { root: r }), /not a known LineageStage/);
  assert.throws(() => verifyStageProvenance(forge(handoff, { trigger: "workflow_run" }), { root: r }), /not a known LineageTrigger/);
  assert.throws(() => verifyStageProvenance(forge(handoff, { trigger: null }), { root: r }), /not a known LineageTrigger/);
  // chain에 들어올 수 없는 stage (root가 이미 담고 있는 plan / plan-authorize, 옆길 workflow)
  for (const stage of ["plan", "plan-authorize", "plan-recovery", "worker-recovery-preflight"]) {
    assert.throws(() => verifyStageProvenance(forge(handoff, { stage }), { root: r }), /cannot appear in a lineage chain/, stage);
  }
});

test("stage: stage + trigger + producer.workflowPath 조합이 STAGE_PRODUCERS와 다르면 digest를 다시 계산해도 거부된다", () => {
  const r = root();
  const handoff = handoffStage(r);
  const combination = /stage\/trigger\/producer combination is not allowed/;
  // handoff에 허용되지 않는 trigger
  assert.throws(() => verifyStageProvenance(forge(handoff, { trigger: "EXPLICIT_RECOVERY" }), { root: r }), combination);
  assert.throws(() => verifyStageProvenance(forge(handoff, { trigger: "SAME_RUN_CONTINUATION" }), { root: r }), combination);
  // handoff인데 다른 workflow가 발행했다고 주장
  assert.throws(
    () => verifyStageProvenance(forge(handoff, { producer: { ...handoff.producer, workflowPath: WORKFLOWS.planImplementWorker.path } }), { root: r }),
    combination,
  );
  assert.throws(
    () => verifyStageProvenance(forge(handoff, { producer: { ...handoff.producer, workflowPath: ".github/workflows/evil.yml" } }), { root: r }),
    combination,
  );
  // create 경로도 같은 검증을 거친다 (type을 우회한 호출)
  assert.throws(
    () => createStageProvenance({ root: r, stage: "handoff", trigger: "RECOVERY_PREFLIGHT", producer: handoff.producer, subject: { digests: {} } }),
    combination,
  );
  assert.throws(
    () => createStageProvenance({ root: r, stage: "handoff", trigger: "issue_comment" as never, producer: handoff.producer, subject: { digests: {} } }),
    /not a known LineageTrigger/,
  );
  // 허용된 다른 조합은 통과한다
  assert.doesNotThrow(() => verifyStageProvenance(forge(handoff, { trigger: "REBIND_REQUEST" }), { root: r }));
});

test("stage: producer/subject shape가 깨진 외부 JSON은 fail-closed", () => {
  const r = root();
  const handoff = handoffStage(r);
  assert.throws(() => verifyStageProvenance({ ...handoff, producer: null }, { root: r }), /producer\/subject shape is invalid/);
  assert.throws(() => verifyStageProvenance({ ...handoff, subject: { digests: [] } }, { root: r }), /producer\/subject shape is invalid/);
  assert.throws(() => verifyStageProvenance({ ...handoff, subject: undefined }, { root: r }), /producer\/subject shape is invalid/);
});

test("chain 시작점: 첫 StageProvenance는 handoff만 허용한다", () => {
  const r = root();
  const handoff = handoffStage(r);
  const first = /first lineage stage must be handoff/;

  // create: parent 없이 worker/bridge/seal/verify로 시작할 수 없다
  const starts: Array<[StageProvenance["stage"], StageProvenance["trigger"], string]> = [
    ["worker", "UPSTREAM_COMPLETION", WORKFLOWS.planImplementWorker.path],
    ["bridge", "UPSTREAM_COMPLETION", WORKFLOWS.planCandidateBridge.path],
    ["bridge", "EXPLICIT_RECOVERY", WORKFLOWS.planCandidateBridge.path],
    ["seal", "UPSTREAM_COMPLETION", WORKFLOWS.trustedRail.path],
    ["verify", "SAME_RUN_CONTINUATION", WORKFLOWS.trustedRail.path],
  ];
  for (const [stage, trigger, workflowPath] of starts) {
    assert.throws(
      () => createStageProvenance({ root: r, stage, trigger, producer: { workflowPath, runId: 1, runAttempt: 1, controlPlaneSha: targetSha }, subject: { digests: {} } }),
      first,
      `${stage}/${trigger}`,
    );
  }

  // verify: parent=rootDigest로 맞추고 digest까지 다시 계산한 worker/bridge record도 거부된다
  const forgedWorker = forge(handoff, { stage: "worker", producer: { ...handoff.producer, workflowPath: WORKFLOWS.planImplementWorker.path } });
  const forgedBridge = forge(handoff, { stage: "bridge", producer: { ...handoff.producer, workflowPath: WORKFLOWS.planCandidateBridge.path } });
  assert.throws(() => verifyStageProvenance(forgedWorker, { root: r }), first);
  assert.throws(() => verifyStageProvenance(forgedBridge, { root: r }), first);
  assert.throws(() => verifyLineageChain(r, [forgedWorker]), first);
  assert.throws(() => verifyLineageChain(r, [forgedBridge]), first);

  // 정상 chain은 handoff에서 시작한다
  assert.doesNotThrow(() => verifyLineageChain(r, []));
  assert.doesNotThrow(() => verifyLineageChain(r, [handoff]));
});

test("chain: 변조된 parent를 기대값으로 넘겨도 parent digest 자체 검증에서 거부된다", () => {
  const r = root();
  const handoff = handoffStage(r);
  const worker = createStageProvenance({
    root: r,
    parent: handoff,
    stage: "worker",
    trigger: "UPSTREAM_COMPLETION",
    producer: { workflowPath: WORKFLOWS.planImplementWorker.path, runId: 200, runAttempt: 1, controlPlaneSha: targetSha },
    subject: { digests: { candidateDigest: "5".repeat(64) } },
  });
  const tamperedParent = { ...handoff, producer: { ...handoff.producer, runId: 999 } };
  assert.throws(() => verifyStageProvenance(worker, { root: r, parent: tamperedParent }), /parent lineage stage digest mismatch/);
});

test("Rail 내부 stage는 SAME_RUN_CONTINUATION으로 handoff → verify 전체 chain을 이룬다", () => {
  const r = root();
  const producer = (workflowPath: string, runId: number) => ({ workflowPath, runId, runAttempt: 1, controlPlaneSha: targetSha });
  const handoff = handoffStage(r);
  const worker = createStageProvenance({ root: r, parent: handoff, stage: "worker", trigger: "UPSTREAM_COMPLETION", producer: producer(WORKFLOWS.planImplementWorker.path, 2), subject: { digests: {} } });
  const bridge = createStageProvenance({ root: r, parent: worker, stage: "bridge", trigger: "UPSTREAM_COMPLETION", producer: producer(WORKFLOWS.planCandidateBridge.path, 3), subject: { digests: {} } });
  const seal = createStageProvenance({ root: r, parent: bridge, stage: "seal", trigger: "UPSTREAM_COMPLETION", producer: producer(WORKFLOWS.trustedRail.path, 4), subject: { digests: {} } });
  const publish = createStageProvenance({ root: r, parent: seal, stage: "publish", trigger: "SAME_RUN_CONTINUATION", producer: producer(WORKFLOWS.trustedRail.path, 4), subject: { digests: {} } });
  const verify = createStageProvenance({ root: r, parent: publish, stage: "verify", trigger: "SAME_RUN_CONTINUATION", producer: producer(WORKFLOWS.trustedRail.path, 4), subject: { digests: {} } });
  assert.deepEqual(
    verifyLineageChain(r, [handoff, worker, bridge, seal, publish, verify]).stages.map((s) => s.stage),
    ["handoff", "worker", "bridge", "seal", "publish", "verify"],
  );
  assert.throws(() => verifyLineageChain(r, [handoff, worker, seal]), /parent digest mismatch/);
});
