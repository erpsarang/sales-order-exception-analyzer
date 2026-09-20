import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  allowedStageTriggers,
  FIRST_CHAIN_STAGE,
  HANDOFF_SOURCE_EVENTS,
  isAllowedStageProducer,
  isChainStage,
  isLineageStage,
  isLineageTrigger,
  isNextStage,
  LINEAGE_CHAIN_STAGES,
  LINEAGE_STAGES,
  LINEAGE_TRIGGERS,
  normalizeTrigger,
  PLAN_TRIGGER_EVENTS,
  STAGE_ORDER,
  STAGE_PRODUCERS,
  stageIndex,
  UPSTREAM_EVENT_ACCEPTANCE,
  WORKFLOWS,
  type LineageStage,
} from "../src/self-improvement/lineage/index.js";
import { createPlanAuthorizeArtifact } from "../src/self-improvement/plan-authorization.js";
import { classifyPlanRecovery, type PlanRunObservation } from "../src/self-improvement/plan-recovery.js";

test("normalizeTrigger: 현재 허용되는 (stage, event, upstream) 조합을 canonical trigger로 바꾼다", () => {
  assert.equal(normalizeTrigger({ stage: "plan", githubEvent: "issues" }), "REQUIREMENT_ISSUE");
  assert.equal(normalizeTrigger({ stage: "plan", githubEvent: "workflow_dispatch", dispatchedBy: "human" }), "MANUAL_DISPATCH");
  assert.equal(normalizeTrigger({ stage: "plan", githubEvent: "workflow_dispatch", dispatchedBy: "plan-recovery" }), "AUTO_REPLAN");
  assert.equal(normalizeTrigger({ stage: "plan-authorize", githubEvent: "issue_comment", commentBody: "PLAN-승인" }), "HUMAN_APPROVAL");
  assert.equal(
    normalizeTrigger({ stage: "handoff", githubEvent: "workflow_run", upstreamWorkflowPath: WORKFLOWS.planAuthorize.path }),
    "UPSTREAM_COMPLETION",
  );
  assert.equal(normalizeTrigger({ stage: "handoff", githubEvent: "issue_comment", commentBody: "PLAN-재개" }), "REBIND_REQUEST");
  assert.equal(
    normalizeTrigger({ stage: "worker", githubEvent: "workflow_run", upstreamWorkflowPath: WORKFLOWS.planImplementHandoff.path }),
    "UPSTREAM_COMPLETION",
  );
  assert.equal(
    normalizeTrigger({ stage: "worker", githubEvent: "workflow_run", upstreamWorkflowPath: WORKFLOWS.planWorkerRecoveryPreflight.path }),
    "RECOVERY_PREFLIGHT",
  );
  assert.equal(
    normalizeTrigger({ stage: "bridge", githubEvent: "workflow_run", upstreamWorkflowPath: WORKFLOWS.planImplementWorker.path }),
    "UPSTREAM_COMPLETION",
  );
  assert.equal(normalizeTrigger({ stage: "bridge", githubEvent: "workflow_dispatch", dispatchedBy: "human" }), "EXPLICIT_RECOVERY");
  assert.equal(normalizeTrigger({ stage: "seal", githubEvent: "workflow_dispatch", dispatchedBy: "candidate-bridge" }), "UPSTREAM_COMPLETION");
  assert.equal(normalizeTrigger({ stage: "seal", githubEvent: "workflow_dispatch", dispatchedBy: "human" }), "EXPLICIT_RECOVERY");
});

test("normalizeTrigger: 허용되지 않는 조합은 fail-closed", () => {
  assert.throws(() => normalizeTrigger({ stage: "plan-authorize", githubEvent: "issue_comment", commentBody: "PLAN-승인 " }), /no producer rule/);
  assert.throws(() => normalizeTrigger({ stage: "handoff", githubEvent: "issue_comment", commentBody: "PLAN-승인" }), /no producer rule/);
  assert.throws(() => normalizeTrigger({ stage: "handoff", githubEvent: "workflow_run", upstreamWorkflowPath: WORKFLOWS.plan.path }), /no producer rule/);
  assert.throws(() => normalizeTrigger({ stage: "worker", githubEvent: "issue_comment", commentBody: "PLAN-재개" }), /no producer rule/);
  assert.throws(() => normalizeTrigger({ stage: "worker", githubEvent: "workflow_run" }), /no producer rule/);
  assert.throws(() => normalizeTrigger({ stage: "bridge", githubEvent: "workflow_dispatch" }), /no producer rule/);
  assert.throws(() => normalizeTrigger({ stage: "publish", githubEvent: "workflow_dispatch", dispatchedBy: "human" }), /no producer rule/);
});

test("STAGE_PRODUCERS의 producer workflow는 실제 workflow 파일의 on: trigger와 일치한다", () => {
  const expectations: Array<[LineageStage, RegExp[]]> = [
    ["plan", [/^on:\n  issues:/m, /workflow_dispatch:/]],
    ["plan-authorize", [/^on:\n  issue_comment:/m]],
    ["plan-recovery", [/workflows: \["Trusted PLAN_AUTHORIZE"\]/]],
    ["handoff", [/workflows: \["Trusted PLAN_AUTHORIZE"\]/, /issue_comment:\n\s+types: \[created\]/]],
    ["worker", [/workflows: \["Trusted PLAN IMPLEMENT Handoff", "Trusted Worker Recovery Preflight"\]/]],
    ["worker-recovery-preflight", [/^on:\n  workflow_dispatch:/m]],
    ["bridge", [/workflows: \["PLAN Bounded IMPLEMENT Worker"\]/, /workflow_dispatch:/]],
    ["seal", [/workflow_dispatch:/, /source_candidate_kind:/]],
  ];
  for (const [stage, patterns] of expectations) {
    const yaml = readFileSync(WORKFLOWS[STAGE_PRODUCERS[stage].workflow].path, "utf8");
    for (const pattern of patterns) assert.match(yaml, pattern, `${stage}: ${pattern}`);
  }
});

test("STAGE_ORDER는 main chain 순서를 고정하고 isNextStage는 인접 관계만 허용한다", () => {
  assert.deepEqual([...STAGE_ORDER], ["plan", "plan-authorize", "handoff", "worker", "bridge", "seal", "publish", "verify"]);
  assert.equal(isNextStage("handoff", "worker"), true);
  assert.equal(isNextStage("worker", "bridge"), true);
  assert.equal(isNextStage("handoff", "bridge"), false);
  assert.equal(isNextStage("worker", "handoff"), false);
  assert.equal(stageIndex("seal"), 5);
  assert.throws(() => stageIndex("worker-recovery-preflight"), /not part of the main lineage chain/);
});

test("runtime vocabulary: isLineageStage / isLineageTrigger는 알려진 값만 허용한다", () => {
  assert.equal(LINEAGE_STAGES.length, 10);
  assert.equal(LINEAGE_TRIGGERS.length, 9);
  assert.deepEqual([...LINEAGE_STAGES].sort(), Object.keys(STAGE_PRODUCERS).sort());
  for (const stage of LINEAGE_STAGES) assert.equal(isLineageStage(stage), true);
  for (const trigger of LINEAGE_TRIGGERS) assert.equal(isLineageTrigger(trigger), true);
  for (const bad of ["", "Handoff", "merge", "workflow_run", null, undefined, 1, {}, ["handoff"]]) {
    assert.equal(isLineageStage(bad), false, `stage ${JSON.stringify(bad)}`);
    assert.equal(isLineageTrigger(bad), false, `trigger ${JSON.stringify(bad)}`);
  }
  // STAGE_PRODUCERS가 쓰는 trigger는 모두 runtime 집합에 있다.
  for (const stage of LINEAGE_STAGES) {
    for (const rule of STAGE_PRODUCERS[stage].rules) assert.equal(isLineageTrigger(rule.trigger), true);
  }
});

test("chain stage: root가 PLAN/승인/base를 담으므로 chain은 handoff에서 시작한다", () => {
  assert.deepEqual([...LINEAGE_CHAIN_STAGES], ["handoff", "worker", "bridge", "seal", "publish", "verify"]);
  assert.equal(FIRST_CHAIN_STAGE, "handoff");
  assert.equal(isChainStage("plan"), false);
  assert.equal(isChainStage("plan-authorize"), false);
  assert.equal(isChainStage("plan-recovery"), false);
  assert.equal(isChainStage("worker-recovery-preflight"), false);
  assert.equal(isChainStage("bridge"), true);
});

test("isAllowedStageProducer: stage + trigger + workflowPath 조합이 STAGE_PRODUCERS와 일치해야 한다", () => {
  assert.deepEqual([...allowedStageTriggers("handoff")], ["UPSTREAM_COMPLETION", "REBIND_REQUEST"]);
  assert.deepEqual([...allowedStageTriggers("worker")], ["UPSTREAM_COMPLETION", "RECOVERY_PREFLIGHT"]);
  assert.deepEqual([...allowedStageTriggers("publish")], ["SAME_RUN_CONTINUATION"]);

  assert.equal(isAllowedStageProducer("handoff", "REBIND_REQUEST", WORKFLOWS.planImplementHandoff.path), true);
  assert.equal(isAllowedStageProducer("worker", "RECOVERY_PREFLIGHT", WORKFLOWS.planImplementWorker.path), true);
  assert.equal(isAllowedStageProducer("bridge", "EXPLICIT_RECOVERY", WORKFLOWS.planCandidateBridge.path), true);
  assert.equal(isAllowedStageProducer("seal", "UPSTREAM_COMPLETION", WORKFLOWS.trustedRail.path), true);
  assert.equal(isAllowedStageProducer("verify", "SAME_RUN_CONTINUATION", WORKFLOWS.trustedRail.path), true);

  // 잘못된 trigger
  assert.equal(isAllowedStageProducer("worker", "REBIND_REQUEST", WORKFLOWS.planImplementWorker.path), false);
  assert.equal(isAllowedStageProducer("handoff", "EXPLICIT_RECOVERY", WORKFLOWS.planImplementHandoff.path), false);
  assert.equal(isAllowedStageProducer("seal", "SAME_RUN_CONTINUATION", WORKFLOWS.trustedRail.path), false);
  // 잘못된 workflowPath
  assert.equal(isAllowedStageProducer("handoff", "UPSTREAM_COMPLETION", WORKFLOWS.planImplementWorker.path), false);
  assert.equal(isAllowedStageProducer("bridge", "UPSTREAM_COMPLETION", ".github/workflows/evil.yml"), false);
  // 알 수 없는 값 / type 우회
  assert.equal(isAllowedStageProducer("merge", "UPSTREAM_COMPLETION", WORKFLOWS.trustedRail.path), false);
  assert.equal(isAllowedStageProducer("handoff", "workflow_run", WORKFLOWS.planImplementHandoff.path), false);
  assert.equal(isAllowedStageProducer("handoff", "UPSTREAM_COMPLETION", undefined), false);
});

test("PLAN_TRIGGER_EVENTS는 plan-authorize/handoff handler가 현재 허용하는 집합과 동일하다 (parity)", () => {
  const authorize = readFileSync("src/self-improvement/plan-authorize-handler.ts", "utf8");
  const handoff = readFileSync("src/self-improvement/plan-implement-handoff-handler.ts", "utf8");
  const literal = JSON.stringify([...PLAN_TRIGGER_EVENTS]).replace(/,/g, ", ");
  assert.ok(authorize.includes(`!${literal}.includes(run.event)`), "authorize handler literal");
  assert.ok(handoff.includes(`!${literal}.includes(planRun.event)`), "handoff handler literal");
  assert.deepEqual([...UPSTREAM_EVENT_ACCEPTANCE.planRunAcceptedBy.planAuthorizeHandler], [...PLAN_TRIGGER_EVENTS]);
  assert.deepEqual([...UPSTREAM_EVENT_ACCEPTANCE.planRunAcceptedBy.planImplementHandoffHandler], [...PLAN_TRIGGER_EVENTS]);
});

test("P1 해소 (Step 1B-1): plan-recovery classifier도 PLAN_TRIGGER_EVENTS와 동일한 PLAN source를 인정한다 (parity)", () => {
  // plan-recovery.ts는 event 리터럴을 하드코딩하지 않고 canonical 집합을 사용한다.
  const recoverySource = readFileSync("src/self-improvement/plan-recovery.ts", "utf8");
  assert.ok(recoverySource.includes('import { PLAN_TRIGGER_EVENTS } from "./lineage/sources.js";'));
  assert.ok(recoverySource.includes("!(PLAN_TRIGGER_EVENTS as readonly string[]).includes(planRun.event)"));
  assert.equal(recoverySource.includes('planRun.event !== "workflow_dispatch"'), false);
  assert.equal(/planRun\.event\s*[!=]==/.test(recoverySource), false, "event literal must not be hardcoded");
  const targetSha = "a".repeat(40);
  const authorization = createPlanAuthorizeArtifact({
    normalizedPlan: {
      requirement: { issueNumber: 57, digest: "b".repeat(64) },
      repository: "erpsarang/sales-order-exception-analyzer",
      targetSha,
      plan: {
        runId: 35419847754,
        runAttempt: 2,
        artifact: { name: "plan-issue-57-35419847754-attempt-2", id: 10577623562, digest: "c".repeat(64) },
        provenanceArtifact: { name: "", id: 0, digest: "" },
      },
    },
    provenanceArtifact: { name: "plan-issue-57-35419847754-attempt-2-provenance", id: 10577897979, digest: "d".repeat(64) },
    currentRequirementDigest: "b".repeat(64),
    currentTargetSha: targetSha,
    approvalCommentId: 5739393840,
    approverUserId: 8370921,
    authorizationRunId: 35420000000,
    authorizationRunAttempt: 1,
  });
  const run = (event: string): PlanRunObservation => ({
    name: "Read-only AI PLAN",
    path: ".github/workflows/plan.yml",
    event,
    status: "completed",
    conclusion: "success",
    runAttempt: 2,
    headBranch: "main",
    headSha: targetSha,
  });
  // 행동 parity: canonical 집합의 모든 event는 인정되고, 그 밖의 event는 fail-closed.
  const classifierAccepts = (event: string): boolean => {
    try {
      classifyPlanRecovery(authorization, run(event), "main", targetSha);
      return true;
    } catch {
      return false;
    }
  };
  for (const event of PLAN_TRIGGER_EVENTS) {
    assert.deepEqual(classifyPlanRecovery(authorization, run(event), "main", targetSha), { required: false, reason: "NONE" }, event);
  }
  const candidates = ["workflow_dispatch", "issues", "issue_comment", "workflow_run", "push", "pull_request", "schedule"];
  assert.deepEqual(candidates.filter(classifierAccepts), [...PLAN_TRIGGER_EVENTS]);
  // 진단 데이터도 runtime과 exact parity: 값을 복제하지 않고 같은 객체를 참조한다.
  const acceptance = UPSTREAM_EVENT_ACCEPTANCE.planRunAcceptedBy;
  assert.equal(acceptance.planRecoveryClassifier, PLAN_TRIGGER_EVENTS);
  assert.deepEqual([...acceptance.planRecoveryClassifier], candidates.filter(classifierAccepts));
});

test("invariant: authorize / handoff / recovery 세 곳은 모두 동일한 PLAN event 집합을 사용한다", () => {
  const acceptance = UPSTREAM_EVENT_ACCEPTANCE.planRunAcceptedBy;
  assert.deepEqual(Object.keys(acceptance).sort(), ["planAuthorizeHandler", "planImplementHandoffHandler", "planRecoveryClassifier"]);
  for (const [consumer, events] of Object.entries(acceptance)) {
    assert.deepEqual([...events], [...PLAN_TRIGGER_EVENTS], consumer);
  }
  // 데이터뿐 아니라 실제 소스도 같은 집합을 쓴다.
  const literal = JSON.stringify([...PLAN_TRIGGER_EVENTS]).replace(/,/g, ", ");
  assert.ok(readFileSync("src/self-improvement/plan-authorize-handler.ts", "utf8").includes(`!${literal}.includes(run.event)`));
  assert.ok(readFileSync("src/self-improvement/plan-implement-handoff-handler.ts", "utf8").includes(`!${literal}.includes(planRun.event)`));
  assert.ok(readFileSync("src/self-improvement/plan-recovery.ts", "utf8").includes("!(PLAN_TRIGGER_EVENTS as readonly string[]).includes(planRun.event)"));
  assert.deepEqual([...PLAN_TRIGGER_EVENTS], ["workflow_dispatch", "issues"]);
});

/** workflow YAML 안의 `![...].includes(<subject>.event)` 리터럴에서 허용 event 집합을 뽑는다. */
function handoffEventsAllowedBy(workflowPath: string, subject: "run" | "handoff"): string[] {
  const yaml = readFileSync(workflowPath, "utf8");
  const pattern = new RegExp(`!\\[([^\\]]+)\\]\\.includes\\(${subject}\\.event\\)`, "g");
  const matches = [...yaml.matchAll(pattern)];
  assert.equal(matches.length, 1, `${workflowPath}: exactly one Handoff event allowlist expected`);
  return matches[0]![1]!.split(",").map((item) => item.trim().replace(/^'(.*)'$/, "$1"));
}

test("P2 해소 (Step 1B-2): Worker / Bridge / Recovery Preflight는 동일한 canonical Handoff source event 집합을 사용한다 (parity)", () => {
  assert.deepEqual([...HANDOFF_SOURCE_EVENTS], ["workflow_run", "issue_comment"]);

  // 진단 데이터는 값을 복제하지 않고 같은 객체를 참조한다.
  const acceptance = UPSTREAM_EVENT_ACCEPTANCE.handoffRunAcceptedBy;
  assert.equal(acceptance.planImplementWorkerWorkflow, HANDOFF_SOURCE_EVENTS);
  assert.equal(acceptance.planCandidateBridgeWorkflow, HANDOFF_SOURCE_EVENTS);
  assert.equal(acceptance.planWorkerRecoveryPreflightWorkflow, HANDOFF_SOURCE_EVENTS);
  assert.deepEqual(Object.keys(acceptance).sort(), [
    "planCandidateBridgeWorkflow",
    "planImplementWorkerLibrary",
    "planImplementWorkerWorkflow",
    "planWorkerRecoveryPreflightWorkflow",
  ]);

  // 실제 workflow YAML 리터럴도 canonical 집합과 exact parity (순서 포함).
  const consumers: Array<[string, "run" | "handoff"]> = [
    [WORKFLOWS.planImplementWorker.path, "run"],
    [WORKFLOWS.planCandidateBridge.path, "handoff"],
    [WORKFLOWS.planWorkerRecoveryPreflight.path, "handoff"],
  ];
  for (const [workflowPath, subject] of consumers) {
    assert.deepEqual(handoffEventsAllowedBy(workflowPath, subject), [...HANDOFF_SOURCE_EVENTS], workflowPath);
  }
});

test("invariant: canonical 집합 밖의 Handoff event는 어떤 consumer도 허용하지 않는다", () => {
  const consumers: Array<[string, "run" | "handoff"]> = [
    [WORKFLOWS.planImplementWorker.path, "run"],
    [WORKFLOWS.planCandidateBridge.path, "handoff"],
    [WORKFLOWS.planWorkerRecoveryPreflight.path, "handoff"],
  ];
  const canonical = new Set<string>(HANDOFF_SOURCE_EVENTS);
  for (const [workflowPath, subject] of consumers) {
    const allowed = handoffEventsAllowedBy(workflowPath, subject);
    for (const event of allowed) assert.ok(canonical.has(event), `${workflowPath} allows non-canonical ${event}`);
    for (const event of ["push", "issues", "workflow_dispatch", "pull_request", "schedule", ""]) {
      assert.equal(allowed.includes(event), false, `${workflowPath} must not allow ${event}`);
    }
  }
  // preflight에 예전 단일 event 비교가 남아 있지 않다.
  const preflight = readFileSync(WORKFLOWS.planWorkerRecoveryPreflight.path, "utf8");
  assert.equal(preflight.includes("handoff.event !== 'workflow_run'"), false);
  assert.equal(/handoff\.event\s*[!=]==/.test(preflight), false);
  // canonical 집합은 Handoff workflow 자신의 producer rule(GitHub event)과 같다.
  assert.deepEqual(
    STAGE_PRODUCERS.handoff.rules.map((rule) => rule.githubEvent).sort(),
    [...HANDOFF_SOURCE_EVENTS].sort(),
  );
});

test("Worker library의 rebind 조건부 규칙은 canonical 집합 안에서 더 강한 조건으로 유지된다", () => {
  const library = UPSTREAM_EVENT_ACCEPTANCE.handoffRunAcceptedBy.planImplementWorkerLibrary;
  assert.deepEqual([...library.withRebind], ["issue_comment"]);
  assert.deepEqual([...library.withoutRebind], ["workflow_run"]);
  for (const event of [...library.withRebind, ...library.withoutRebind]) {
    assert.ok((HANDOFF_SOURCE_EVENTS as readonly string[]).includes(event), event);
  }
  assert.deepEqual([...library.withRebind, ...library.withoutRebind].sort(), [...HANDOFF_SOURCE_EVENTS].sort());
  const source = readFileSync("src/self-improvement/plan-implement-worker.ts", "utf8");
  assert.ok(source.includes('const expectedEvent = bundle.rebind ? "issue_comment" : "workflow_run";'));
  assert.ok(source.includes("if (source.event !== expectedEvent || source.conclusion !== \"success\") {"));
});
