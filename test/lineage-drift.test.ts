import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BRIDGE_RECOVERY_DRIFT_POLICY,
  BRIDGE_RECOVERY_FRAMEWORK_ROOT_TESTS,
  classifyDrift,
  classifyDriftAcrossPolicies,
  DRIFT_POLICIES,
  NO_DRIFT_POLICY,
  REBIND_DRIFT_POLICY,
  TRUSTED_RAIL_RECOVERY_DRIFT_FILES,
  TRUSTED_RAIL_RECOVERY_DRIFT_POLICY,
  WORKER_RECOVERY_PREFLIGHT_DRIFT_FILES,
  WORKER_RECOVERY_PREFLIGHT_DRIFT_POLICY,
  type DriftFile,
} from "../src/self-improvement/lineage/index.js";
import { createPlanAuthorizeArtifact } from "../src/self-improvement/plan-authorization.js";
import { createPlanRebindProvenance, PLAN_REBIND_MAX_DRIFT_FILES } from "../src/self-improvement/plan-implement-handoff.js";

const modified = (path: string): DriftFile => ({ path, status: "modified" });
const added = (path: string): DriftFile => ({ path, status: "added" });

test("classifyDrift: 빈 목록은 allowEmpty 정책에서 NONE, rebind 정책에서는 APP_TOUCHING", () => {
  assert.equal(classifyDrift([], BRIDGE_RECOVERY_DRIFT_POLICY).class, "NONE");
  assert.equal(classifyDrift([], REBIND_DRIFT_POLICY).class, "APP_TOUCHING");
});

test("classifyDrift: framework 경로 added/modified만 FRAMEWORK_ONLY, 그 외는 이유와 함께 APP_TOUCHING", () => {
  const ok = classifyDrift([modified("src/self-improvement/x.ts"), added(".github/workflows/y.yml")], REBIND_DRIFT_POLICY);
  assert.equal(ok.class, "FRAMEWORK_ONLY");
  assert.deepEqual(ok.changedPaths, [".github/workflows/y.yml", "src/self-improvement/x.ts"]);
  assert.deepEqual(ok.rejections, []);

  const app = classifyDrift([modified("src/order-analysis.ts")], REBIND_DRIFT_POLICY);
  assert.equal(app.class, "APP_TOUCHING");
  assert.deepEqual(app.rejections, [{ path: "src/order-analysis.ts", reason: "PATH_NOT_FRAMEWORK" }]);

  const removed = classifyDrift([{ path: "src/self-improvement/x.ts", status: "removed" }], REBIND_DRIFT_POLICY);
  assert.deepEqual(removed.rejections, [{ path: "src/self-improvement/x.ts", reason: "STATUS_NOT_ALLOWED" }]);

  const renamed = classifyDrift([{ path: "src/self-improvement/x.ts", status: "modified", previousPath: "src/self-improvement/w.ts" }], REBIND_DRIFT_POLICY);
  assert.deepEqual(renamed.rejections, [{ path: "src/self-improvement/x.ts", reason: "RENAMED" }]);

  const overlap = classifyDrift([modified("src/self-improvement/x.ts")], REBIND_DRIFT_POLICY, { protectedPaths: ["src/self-improvement/x.ts"] });
  assert.equal(overlap.class, "APP_TOUCHING");
  assert.deepEqual(overlap.rejections, [{ path: "src/self-improvement/x.ts", reason: "OVERLAPS_PROTECTED_PATH" }]);
});

test("classifyDrift: 파일 수 상한 초과는 exceedsMaxFiles로 APP_TOUCHING", () => {
  const files = Array.from({ length: PLAN_REBIND_MAX_DRIFT_FILES + 1 }, (_, i) => modified(`src/self-improvement/f${i}.ts`));
  const result = classifyDrift(files, REBIND_DRIFT_POLICY);
  assert.equal(result.class, "APP_TOUCHING");
  assert.equal(result.exceedsMaxFiles, true);
  assert.deepEqual(result.rejections, []);
  assert.equal(classifyDrift(files.slice(0, PLAN_REBIND_MAX_DRIFT_FILES), REBIND_DRIFT_POLICY).class, "FRAMEWORK_ONLY");
});

test("REBIND_DRIFT_POLICY는 createPlanRebindProvenance와 같은 입력을 같은 결과로 판정한다 (parity)", () => {
  const targetSha = "b".repeat(40);
  const approved = createPlanAuthorizeArtifact({
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
  const planValue = {
    kind: "untrusted-plan",
    repository: approved.repository,
    sha: targetSha,
    requirement: "README 상태 설명을 추가한다",
    context: { digestAlgorithm: "sha256", digest: "8".repeat(64), evidence: [{ path: "src/order-analysis.ts" }], totalBytes: 0 },
    plan: {
      questions: [],
      approach: ["README 상태 설명을 추가한다"],
      implementationScope: { ready: true, allowedPaths: ["README.md"], requiredChanges: ["x"], forbiddenChanges: [], validationCommands: ["npm test"] },
    },
  };
  const protectedPaths = ["src/order-analysis.ts", "README.md"];
  const cases: Array<[string[], boolean]> = [
    [["src/self-improvement/deterministic-ci.ts"], true],
    [[".github/workflows/plan.yml", "test/plan-recovery.test.ts"], true],
    [["src/order-analysis-cli.ts"], false],
    [["README.md"], false],                     // allowedPaths overlap
    [["test/a.test.ts", "src/order-analysis.ts"], false], // context evidence overlap
    [["package.json"], false],
    [[], false],
  ];
  for (const [paths, expectedOk] of cases) {
    const legacyOk = (() => {
      try { createPlanRebindProvenance(approved, planValue, "9".repeat(40), paths); return true; } catch { return false; }
    })();
    const canonical = classifyDrift(paths.map(modified), REBIND_DRIFT_POLICY, { protectedPaths }).class === "FRAMEWORK_ONLY";
    assert.equal(legacyOk, expectedOk, `legacy ${JSON.stringify(paths)}`);
    assert.equal(canonical, expectedOk, `canonical ${JSON.stringify(paths)}`);
  }
});

test("YAML allowlist 스냅샷은 실제 workflow 파일과 동일하다 (parity)", () => {
  const preflight = readFileSync(".github/workflows/plan-worker-recovery-preflight.yml", "utf8");
  for (const file of WORKER_RECOVERY_PREFLIGHT_DRIFT_FILES) assert.ok(preflight.includes(`'${file}',`), `preflight ${file}`);
  assert.equal((preflight.match(/^\s+'[^']+',$/gm) ?? []).length, WORKER_RECOVERY_PREFLIGHT_DRIFT_FILES.length);
  assert.match(preflight, /files\.length > 12/);
  assert.equal(WORKER_RECOVERY_PREFLIGHT_DRIFT_POLICY.maxFiles, 12);

  const rail = readFileSync(".github/workflows/trusted-rail.yml", "utf8");
  for (const file of TRUSTED_RAIL_RECOVERY_DRIFT_FILES) assert.ok(rail.includes(`'${file}',`), `rail ${file}`);
  assert.match(rail, /files\.length > 8/);
  assert.equal(TRUSTED_RAIL_RECOVERY_DRIFT_POLICY.maxFiles, 8);

  const bridge = readFileSync(".github/workflows/plan-candidate-bridge.yml", "utf8");
  for (const file of BRIDGE_RECOVERY_FRAMEWORK_ROOT_TESTS) assert.ok(bridge.includes(`'${file}',`), `bridge ${file}`);
  assert.match(bridge, /files\.length > 50/);
  assert.match(bridge, /path\.startsWith\('test\/self-improvement\/'\)/);
  assert.match(bridge, /path === 'FRAMEWORK\.md'/);
  assert.match(bridge, /const frameworkDoc = \/\^docs\\\/\(\?:self-improvement\\\/\|\(\?:architecture\|trust-model\|state-machine\|phase-\[1-6\]-\[\^\/\]\+\|orchestrator-smoke\|fix-loop-smoke-\[\^\/\]\+\)\\\.md\$\)\//);
  assert.equal(BRIDGE_RECOVERY_DRIFT_POLICY.maxFiles, 50);
});

test("정책 스냅샷의 개별 판정은 YAML 로직과 같다 (parity)", () => {
  assert.equal(BRIDGE_RECOVERY_DRIFT_POLICY.isFrameworkPath("docs/self-improvement/x.md"), true);
  assert.equal(BRIDGE_RECOVERY_DRIFT_POLICY.isFrameworkPath("docs/phase-3-plan.md"), true);
  assert.equal(BRIDGE_RECOVERY_DRIFT_POLICY.isFrameworkPath("docs/framework-v0.1-usage.md"), false);
  assert.equal(BRIDGE_RECOVERY_DRIFT_POLICY.isFrameworkPath("test/self-improvement/plan-implement-worker-recovery.test.ts"), true);
  assert.equal(BRIDGE_RECOVERY_DRIFT_POLICY.isFrameworkPath("test/order-analysis.test.ts"), false);
  assert.equal(BRIDGE_RECOVERY_DRIFT_POLICY.isFrameworkPath("FRAMEWORK.md"), true);
  assert.equal(WORKER_RECOVERY_PREFLIGHT_DRIFT_POLICY.isFrameworkPath("src/self-improvement/plan-recovery.ts"), false);
  assert.equal(TRUSTED_RAIL_RECOVERY_DRIFT_POLICY.isFrameworkPath(".github/workflows/plan-implement-worker.yml"), false);
  assert.equal(NO_DRIFT_POLICY.isFrameworkPath(".github/workflows/plan-implement-worker.yml"), false);
  assert.equal(classifyDrift([], NO_DRIFT_POLICY).class, "NONE");
  assert.equal(classifyDrift([modified("src/self-improvement/x.ts")], NO_DRIFT_POLICY).class, "APP_TOUCHING");
});

test("진단: 같은 Framework 커밋이 stage마다 다르게 판정된다 (현재 구조의 불일치를 고정)", () => {
  assert.equal(DRIFT_POLICIES.length, 5);
  const workerFix = [modified(".github/workflows/plan-implement-worker.yml"), modified("test/plan-implement-worker-workflow.test.ts")];
  assert.deepEqual(classifyDriftAcrossPolicies(workerFix), {
    "plan-rebind-v1": "FRAMEWORK_ONLY",
    "worker-recovery-preflight-v1": "FRAMEWORK_ONLY",
    "candidate-bridge-recovery-v1": "FRAMEWORK_ONLY",
    "trusted-rail-plan-bridge-recovery-v1": "APP_TOUCHING",
    "plan-authorize-no-drift-v1": "APP_TOUCHING",
  });
  const recoveryFix = [modified("src/self-improvement/plan-recovery.ts"), modified("test/plan-recovery.test.ts")];
  assert.deepEqual(classifyDriftAcrossPolicies(recoveryFix), {
    "plan-rebind-v1": "FRAMEWORK_ONLY",
    "worker-recovery-preflight-v1": "APP_TOUCHING",
    "candidate-bridge-recovery-v1": "APP_TOUCHING",
    "trusted-rail-plan-bridge-recovery-v1": "APP_TOUCHING",
    "plan-authorize-no-drift-v1": "APP_TOUCHING",
  });
});
