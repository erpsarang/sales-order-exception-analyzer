import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImplementContextPack } from "../src/self-improvement/context-pack.js";
import { controlPlaneRelation, effectiveBase } from "../src/self-improvement/lineage/index.js";
import { createPlanAuthorizeArtifact, planAuthorizeArtifactName } from "../src/self-improvement/plan-authorization.js";
import {
  createPlanImplementContract,
  createPlanImplementHandoffManifest,
  createPlanRebindProvenance,
} from "../src/self-improvement/plan-implement-handoff.js";
import { verifyPlanImplementWorkerBundle } from "../src/self-improvement/plan-implement-worker.js";
import { createSinglePassPrompt, WORKER_OUTPUT_SCHEMA } from "../src/self-improvement/single-pass-worker.js";

const targetSha = "b".repeat(40);
const reboundTargetSha = "9".repeat(40);

function authorization() {
  return createPlanAuthorizeArtifact({
    normalizedPlan: {
      requirement: { issueNumber: 83, digest: "a".repeat(64) },
      repository: "erpsarang/self-improvement-mvp",
      targetSha,
      plan: {
        runId: 34730034257,
        runAttempt: 1,
        artifact: { name: "plan-issue-83-34730034257-attempt-1", id: 10308609510, digest: "c".repeat(64) },
        provenanceArtifact: { name: "", id: 0, digest: "" },
      },
    },
    provenanceArtifact: { name: "plan-issue-83-34730034257-attempt-1-provenance", id: 10308699321, digest: "d".repeat(64) },
    currentRequirementDigest: "a".repeat(64),
    currentTargetSha: targetSha,
    approvalCommentId: 5649914569,
    approverUserId: 8370921,
    authorizationRunId: 34730287415,
    authorizationRunAttempt: 1,
  });
}

const planValue = {
  kind: "untrusted-plan",
  repository: "erpsarang/self-improvement-mvp",
  sha: targetSha,
  requirement: "README 상태 설명을 추가한다",
  context: { digestAlgorithm: "sha256", digest: "8".repeat(64), evidence: [], totalBytes: 0 },
  plan: {
    questions: [],
    approach: ["README 상태 설명을 추가한다"],
    implementationScope: {
      ready: true,
      allowedPaths: ["README.md"],
      requiredChanges: ["README 상태 설명 추가"],
      forbiddenChanges: [],
      validationCommands: ["npm test"],
    },
  },
};

test("effectiveBase: rebind가 없으면 승인 SHA 그대로 (APPROVED)", () => {
  const base = effectiveBase({ targetSha });
  assert.deepEqual(base, { sha: targetSha, kind: "APPROVED", approvedSha: targetSha });
});

test("effectiveBase: rebind가 있으면 rebound SHA (REBOUND), 승인 SHA는 approvedSha에 보존", () => {
  const base = effectiveBase({ targetSha }, { sourceTargetSha: targetSha, reboundTargetSha });
  assert.deepEqual(base, { sha: reboundTargetSha, kind: "REBOUND", approvedSha: targetSha });
});

test("effectiveBase: 잘못된 rebind는 fail-closed", () => {
  assert.throws(() => effectiveBase({ targetSha: "zz" }), /approved target SHA/);
  assert.throws(
    () => effectiveBase({ targetSha }, { sourceTargetSha: "c".repeat(40), reboundTargetSha }),
    /does not match approved target SHA/,
  );
  assert.throws(
    () => effectiveBase({ targetSha }, { sourceTargetSha: targetSha, reboundTargetSha: targetSha }),
    /moved target SHA/,
  );
  assert.throws(
    () => effectiveBase({ targetSha }, { sourceTargetSha: targetSha, reboundTargetSha: "not-a-sha" }),
    /rebound target SHA/,
  );
});

test("effectiveBase는 기존 contract/handoff/bundle이 각자 계산한 baseSha와 byte-identical하다 (parity, no rebind)", () => {
  const approved = authorization();
  const contract = createPlanImplementContract(approved, planValue);
  const base = effectiveBase(approved);
  assert.equal(contract.baseSha, base.sha);
  assert.equal(base.kind, "APPROVED");
});

test("effectiveBase는 기존 contract/handoff/bundle이 각자 계산한 baseSha와 byte-identical하다 (parity, rebind)", () => {
  const approved = authorization();
  const rebind = createPlanRebindProvenance(approved, planValue, reboundTargetSha, ["src/self-improvement/deterministic-ci.ts"]);
  const contract = createPlanImplementContract(approved, planValue, rebind);
  const root = mkdtempSync(join(tmpdir(), "lineage-base-test-"));
  writeFileSync(join(root, "README.md"), "# Framework\n");
  const context = createImplementContextPack(contract, root, reboundTargetSha);
  rmSync(root, { recursive: true, force: true });
  const sourceArtifact = { name: planAuthorizeArtifactName(approved), id: 10309133636, digest: "e".repeat(64) };
  const manifest = createPlanImplementHandoffManifest({ authorization: approved, sourceArtifact, contract, contextDigest: context.contextDigest, rebind });
  const bundle = verifyPlanImplementWorkerBundle({
    contract,
    context,
    handoff: manifest,
    source: { authorization: approved, sourceArtifact, rebind },
    prompt: createSinglePassPrompt(contract, context),
    schema: WORKER_OUTPUT_SCHEMA,
  });

  const base = effectiveBase(approved, rebind);
  assert.equal(base.kind, "REBOUND");
  assert.equal(contract.baseSha, base.sha);       // plan-implement-handoff.ts:459
  assert.equal(manifest.baseSha, base.sha);       // plan-implement-handoff.ts:493
  assert.equal(bundle.contract.baseSha, base.sha); // plan-implement-worker.ts:170
  assert.equal(base.approvedSha, approved.targetSha);
});

test("controlPlaneRelation은 SHA 비교로 알 수 있는 사실만 말한다 (ancestry는 판정하지 않는다)", () => {
  assert.equal(controlPlaneRelation(targetSha, targetSha), "SAME_AS_BASE");
  assert.equal(controlPlaneRelation(targetSha, reboundTargetSha), "DIFFERENT_FROM_BASE");
  // 방향을 바꿔도 같은 사실만 돌려준다: ahead/behind/diverged는 compare 결과 없이는 알 수 없다.
  assert.equal(controlPlaneRelation(reboundTargetSha, targetSha), "DIFFERENT_FROM_BASE");
  assert.throws(() => controlPlaneRelation(targetSha, "x"), /control-plane SHA/);
});
