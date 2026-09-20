import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImplementContextPack } from "../src/self-improvement/context-pack.js";
import {
  createHandoffLineage,
  handoffLineageArtifactName,
  handoffTriggerFromGitHubEvent,
  verifyHandoffLineage,
  type CreateHandoffLineageInput,
} from "../src/self-improvement/lineage/handoff-lineage.js";
import {
  ARTIFACT_NAME_PATTERNS,
  lineageDigestOf,
  verifyLineageChain,
  WORKFLOWS,
} from "../src/self-improvement/lineage/index.js";
import { createPlanAuthorizeArtifact, planAuthorizeArtifactName } from "../src/self-improvement/plan-authorization.js";
import {
  createPlanImplementContract,
  createPlanImplementHandoffManifest,
  createPlanRebindProvenance,
  planImplementHandoffArtifactName,
} from "../src/self-improvement/plan-implement-handoff.js";
import { createSinglePassPrompt, WORKER_OUTPUT_SCHEMA } from "../src/self-improvement/single-pass-worker.js";

const targetSha = "b".repeat(40);
const reboundTargetSha = "9".repeat(40);

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

const planValue = {
  kind: "untrusted-plan",
  repository: "erpsarang/sales-order-exception-analyzer",
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

function fixture(withRebind: boolean) {
  const approved = authorization();
  const rebind = withRebind
    ? createPlanRebindProvenance(approved, planValue, reboundTargetSha, ["src/self-improvement/deterministic-ci.ts"])
    : undefined;
  const contract = createPlanImplementContract(approved, planValue, rebind);
  const root = mkdtempSync(join(tmpdir(), "lineage-handoff-target-"));
  writeFileSync(join(root, "README.md"), "# Framework\n");
  const context = createImplementContextPack(contract, root, contract.baseSha);
  rmSync(root, { recursive: true, force: true });
  const sourceArtifact = { name: planAuthorizeArtifactName(approved), id: 10309133636, digest: "e".repeat(64) };
  const manifest = createPlanImplementHandoffManifest({
    authorization: approved,
    sourceArtifact,
    contract,
    contextDigest: context.contextDigest,
    ...(rebind ? { rebind } : {}),
  });
  const input: CreateHandoffLineageInput = {
    authorization: approved,
    ...(rebind ? { rebind } : {}),
    contract,
    contextDigest: context.contextDigest,
    manifest,
    trigger: withRebind ? "REBIND_REQUEST" : "UPSTREAM_COMPLETION",
    producer: { runId: 35600000001, runAttempt: 1, controlPlaneSha: contract.baseSha },
  };
  return { approved, rebind, contract, context, manifest, sourceArtifact, input };
}

test("normal Handoff: APPROVED root가 승인 PLAN identity를 exact하게 담는다", () => {
  const { approved, input } = fixture(false);
  const { root } = createHandoffLineage(input);
  assert.equal(root.repository, approved.repository);
  assert.equal(root.issueNumber, approved.requirement.issueNumber);
  assert.equal(root.requirementDigest, approved.requirement.digest);
  assert.deepEqual(root.plan, {
    runId: approved.plan.runId,
    runAttempt: approved.plan.runAttempt,
    targetSha: approved.targetSha,
    artifact: approved.plan.artifact,
    provenanceArtifact: approved.plan.provenanceArtifact,
  });
  assert.deepEqual(root.approval, {
    commentId: approved.approval.commentId,
    approverUserId: approved.approval.approverUserId,
    authorizationDigest: approved.authorizationDigest,
  });
  assert.deepEqual(root.base, { sha: approved.targetSha, kind: "APPROVED" });
});

test("PLAN-재개 rebind Handoff: REBOUND root + rebindDigest, 승인 SHA는 plan.targetSha에 보존", () => {
  const { approved, rebind, contract, input } = fixture(true);
  const { root } = createHandoffLineage(input);
  assert.deepEqual(root.base, { sha: reboundTargetSha, kind: "REBOUND", rebindDigest: rebind!.rebindDigest });
  assert.equal(root.plan.targetSha, approved.targetSha);
  assert.equal(root.base.sha, contract.baseSha); // 기존 contract baseSha와 exact parity
});

test("Handoff stage: parent=rootDigest, canonical producer, contract/context/handoff digest exact 결합", () => {
  for (const withRebind of [false, true]) {
    const { contract, context, manifest, input } = fixture(withRebind);
    const lineage = createHandoffLineage(input);
    const { root, handoff } = lineage;
    assert.equal(handoff.stage, "handoff");
    assert.equal(handoff.rootDigest, root.rootDigest);
    assert.equal(handoff.parentLineageDigest, root.rootDigest);
    assert.equal(handoff.trigger, withRebind ? "REBIND_REQUEST" : "UPSTREAM_COMPLETION");
    assert.deepEqual(handoff.producer, {
      workflowPath: WORKFLOWS.planImplementHandoff.path,
      runId: 35600000001,
      runAttempt: 1,
      controlPlaneSha: contract.baseSha,
    });
    assert.deepEqual(handoff.subject, {
      digests: {
        contractDigest: contract.contractDigest,
        contextDigest: context.contextDigest,
        handoffDigest: manifest.handoffDigest,
      },
    });
    assert.deepEqual(verifyLineageChain(root, [handoff]).stages.map((s) => s.stage), ["handoff"]);
    assert.deepEqual(verifyHandoffLineage(JSON.parse(JSON.stringify(lineage))), lineage);
  }
});

test("GitHub event → Handoff trigger 정규화와 base kind 결합", () => {
  assert.equal(handoffTriggerFromGitHubEvent("workflow_run"), "UPSTREAM_COMPLETION");
  assert.equal(handoffTriggerFromGitHubEvent("issue_comment"), "REBIND_REQUEST");
  for (const event of ["workflow_dispatch", "issues", "push", ""]) {
    assert.throws(() => handoffTriggerFromGitHubEvent(event), /unsupported Handoff GitHub event/, event);
  }
  // rebind 없이 REBIND_REQUEST, rebind인데 UPSTREAM_COMPLETION은 fail-closed
  assert.throws(() => createHandoffLineage({ ...fixture(false).input, trigger: "REBIND_REQUEST" }), /trigger must be UPSTREAM_COMPLETION for APPROVED base/);
  assert.throws(() => createHandoffLineage({ ...fixture(true).input, trigger: "UPSTREAM_COMPLETION" }), /trigger must be REBIND_REQUEST for REBOUND base/);
  assert.throws(() => createHandoffLineage({ ...fixture(false).input, trigger: "EXPLICIT_RECOVERY" }), /trigger must be UPSTREAM_COMPLETION/);
});

test("잘못된 run identity / SHA / digest는 fail-closed", () => {
  const { input, contract, manifest, approved } = fixture(false);
  const producer = input.producer;
  assert.throws(() => createHandoffLineage({ ...input, producer: { ...producer, runId: 0 } }), /producer\.runId/);
  assert.throws(() => createHandoffLineage({ ...input, producer: { ...producer, runAttempt: 1.5 } }), /producer\.runAttempt/);
  assert.throws(() => createHandoffLineage({ ...input, producer: { ...producer, controlPlaneSha: "not-a-sha" } }), /controlPlaneSha must be a Git SHA/);
  assert.throws(() => createHandoffLineage({ ...input, producer: { ...producer, controlPlaneSha: "7".repeat(40) } }), /must equal the effective base SHA/);
  assert.throws(() => createHandoffLineage({ ...input, contextDigest: "nope" }), /contextDigest must be a lowercase SHA-256/);
  assert.throws(() => createHandoffLineage({ ...input, contextDigest: "1".repeat(64) }), /manifest does not match/);
  assert.throws(() => createHandoffLineage({ ...input, manifest: { ...manifest, handoffDigest: "2".repeat(64) } }), /manifest does not match/);
  assert.throws(() => createHandoffLineage({ ...input, manifest: { ...manifest, approvalCommentId: 1 } }), /manifest does not match/);
  assert.throws(() => createHandoffLineage({ ...input, contract: { ...contract, contractDigest: "3".repeat(64) } }), /digest or canonical shape mismatch/);
  assert.throws(() => createHandoffLineage({ ...input, authorization: { ...approved, targetSha: "4".repeat(40) } }), /PLAN_AUTHORIZE artifact digest mismatch/);
  // rebind provenance를 normal manifest에 끼워 넣을 수 없다
  const rebound = fixture(true);
  assert.throws(() => createHandoffLineage({ ...input, rebind: rebound.rebind!, trigger: "REBIND_REQUEST" }), /not bound to approved PLAN\/rebind identity|manifest does not match/);
  assert.throws(() => createHandoffLineage({ ...rebound.input, rebind: { ...rebound.rebind!, reboundTargetSha: "5".repeat(40) } }), /PLAN rebind provenance digest mismatch/);
});

test("verifyHandoffLineage: 변조/추가 필드/재계산된 digest도 fail-closed", () => {
  const lineage = createHandoffLineage(fixture(false).input);
  const reforge = (patch: Record<string, unknown>) => {
    const { digestAlgorithm: _a, lineageDigest: _d, ...payload } = { ...lineage.handoff, ...patch } as Record<string, unknown>;
    return { ...lineage, handoff: { ...payload, digestAlgorithm: "sha256", lineageDigest: lineageDigestOf(payload) } };
  };
  assert.doesNotThrow(() => verifyHandoffLineage(reforge({})));
  assert.throws(() => verifyHandoffLineage({ ...lineage, extra: 1 }), /shape is invalid/);
  assert.throws(() => verifyHandoffLineage({ ...lineage, kind: "other" }), /unsupported Handoff lineage schema/);
  assert.throws(() => verifyHandoffLineage({ ...lineage, root: { ...lineage.root, issueNumber: 1 } }), /digest mismatch/);
  assert.throws(() => verifyHandoffLineage(reforge({ trigger: "REBIND_REQUEST" })), /trigger must be UPSTREAM_COMPLETION for APPROVED base/);
  assert.throws(() => verifyHandoffLineage(reforge({ producer: { ...lineage.handoff.producer, controlPlaneSha: "7".repeat(40) } })), /must equal the effective base SHA/);
  assert.throws(() => verifyHandoffLineage(reforge({ subject: { digests: { contractDigest: "1".repeat(64) } } })), /subject is missing contextDigest/);
  assert.throws(() => verifyHandoffLineage(reforge({ producer: { ...lineage.handoff.producer, workflowPath: WORKFLOWS.planImplementWorker.path } })), /combination is not allowed/);
});

test("lineage 생성은 기존 manifest/contract/digest를 바꾸지 않는다", () => {
  for (const withRebind of [false, true]) {
    const { approved, rebind, contract, context, manifest, sourceArtifact, input } = fixture(withRebind);
    const before = JSON.stringify({ contract, context, manifest, approved, rebind });
    createHandoffLineage(input);
    assert.equal(JSON.stringify({ contract, context, manifest, approved, rebind }), before);
    const regenerated = createPlanImplementHandoffManifest({
      authorization: approved,
      sourceArtifact,
      contract,
      contextDigest: context.contextDigest,
      ...(rebind ? { rebind } : {}),
    });
    assert.equal(regenerated.handoffDigest, manifest.handoffDigest);
    assert.equal(Object.keys(manifest).includes("lineageDigest"), false);
    assert.equal(JSON.stringify(manifest).includes("lineage"), false);
  }
});

test("shadow artifact 이름은 기존 Handoff artifact 선택 규칙에 매치되지 않는다", () => {
  const name = planImplementHandoffArtifactName(authorization());
  const shadow = handoffLineageArtifactName(name);
  assert.equal(shadow, `${name}-lineage`);
  assert.match(name, ARTIFACT_NAME_PATTERNS.planImplementHandoff);
  assert.doesNotMatch(shadow, ARTIFACT_NAME_PATTERNS.planImplementHandoff);
  assert.doesNotMatch(shadow, /^plan-implement-handoff-issue-\d+-plan-\d+-attempt-\d+-approval-\d+$/); // worker.yml의 선택 정규식
  assert.throws(() => handoffLineageArtifactName("evil"), /artifact name is invalid/);
  assert.throws(() => handoffLineageArtifactName(shadow), /artifact name is invalid/);
});

test("handler `lineage` command: 기존 Handoff 파일 6개는 byte-identical, 별도 디렉터리에 lineage.json만 추가된다", () => {
  for (const withRebind of [false, true]) {
    const { approved, rebind, contract, context, manifest, sourceArtifact } = fixture(withRebind);
    const work = mkdtempSync(join(tmpdir(), "lineage-handoff-handler-"));
    const handoffDir = join(work, "plan-implement-handoff");
    const lineageDir = join(work, "plan-implement-handoff-lineage");
    mkdirSync(handoffDir);
    const files: Record<string, string> = {
      "contract.json": JSON.stringify(contract, null, 2),
      "context.json": JSON.stringify(context, null, 2),
      "prompt.md": createSinglePassPrompt(contract, context),
      "schema.json": JSON.stringify(WORKER_OUTPUT_SCHEMA, null, 2),
      "handoff.json": JSON.stringify(manifest, null, 2),
      "source.json": JSON.stringify({ authorization: approved, sourceArtifact, ...(rebind ? { rebind } : {}) }, null, 2),
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(handoffDir, name), content);

    const run = (env: Record<string, string>) => spawnSync(
      process.execPath,
      ["--import", "tsx", "src/self-improvement/plan-implement-handoff-handler.ts", "lineage"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HANDOFF_OUTPUT: handoffDir,
          LINEAGE_OUTPUT: lineageDir,
          HANDOFF_RUN_ID: "35600000001",
          HANDOFF_RUN_ATTEMPT: "2",
          HANDOFF_EVENT_NAME: withRebind ? "issue_comment" : "workflow_run",
          EXPECTED_CONTROL_SHA: contract.baseSha,
          OBSERVED_CONTROL_SHA: contract.baseSha,
          GITHUB_OUTPUT: "",
          ...env,
        },
      },
    );

    try {
      // fail-closed: checkout SHA 불일치, event/rebind 불일치는 lineage를 만들지 않는다
      const mismatch = run({ OBSERVED_CONTROL_SHA: "7".repeat(40) });
      assert.notEqual(mismatch.status, 0);
      assert.match(mismatch.stderr, /control-plane checkout SHA mismatch/);
      const wrongEvent = run({ HANDOFF_EVENT_NAME: withRebind ? "workflow_run" : "issue_comment" });
      assert.notEqual(wrongEvent.status, 0);
      assert.match(wrongEvent.stderr, /trigger must be/);
      assert.deepEqual(readdirSync(work).sort(), ["plan-implement-handoff"]);

      const ok = run({});
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(readdirSync(handoffDir).sort(), Object.keys(files).sort());
      for (const [name, content] of Object.entries(files)) {
        assert.equal(readFileSync(join(handoffDir, name), "utf8"), content, `${name} must be byte-identical`);
      }
      assert.deepEqual(readdirSync(lineageDir), ["lineage.json"]);
      const lineage = verifyHandoffLineage(JSON.parse(readFileSync(join(lineageDir, "lineage.json"), "utf8")));
      assert.equal(lineage.root.base.kind, withRebind ? "REBOUND" : "APPROVED");
      assert.equal(lineage.handoff.trigger, withRebind ? "REBIND_REQUEST" : "UPSTREAM_COMPLETION");
      assert.equal(lineage.handoff.producer.runId, 35600000001);
      assert.equal(lineage.handoff.producer.runAttempt, 2);
      assert.equal(lineage.handoff.producer.controlPlaneSha, contract.baseSha);
      assert.equal(lineage.handoff.subject.digests.handoffDigest, manifest.handoffDigest);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
});
