/**
 * Canonical Execution Lineage — drift classifier (pure policy).
 *
 * "approved/base SHA → 현재 default SHA" 사이의 변경 파일 목록을 받아
 * NONE / FRAMEWORK_ONLY / APP_TOUCHING 으로 분류한다.
 *
 * 현재 repo에는 같은 개념의 allowlist가 5곳에 따로 있다. Step 1A에서는 그 5개를
 * "데이터"로 옮겨 적기만 한다 (판정 변경 없음). 어떤 정책을 canonical로 삼을지는
 * 후속 단계에서 사람이 결정한다.
 */

export type DriftClass = "NONE" | "FRAMEWORK_ONLY" | "APP_TOUCHING";

export type DriftFileStatus = "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";

export interface DriftFile {
  readonly path: string;
  readonly status: DriftFileStatus;
  readonly previousPath?: string;
}

export type DriftRejectReason =
  | "STATUS_NOT_ALLOWED"
  | "RENAMED"
  | "PATH_NOT_FRAMEWORK"
  | "OVERLAPS_PROTECTED_PATH";

export interface DriftRejection {
  readonly path: string;
  readonly reason: DriftRejectReason;
}

export interface DriftPolicy {
  readonly id: string;
  /** 허용 파일 수 상한 (초과 시 APP_TOUCHING) */
  readonly maxFiles: number;
  /** 0개 변경을 허용하는지 (rebind는 1개 이상을 요구) */
  readonly allowEmpty: boolean;
  readonly allowedStatuses: readonly DriftFileStatus[];
  readonly isFrameworkPath: (path: string) => boolean;
}

export interface DriftClassification {
  readonly policyId: string;
  readonly class: DriftClass;
  readonly changedPaths: readonly string[];
  readonly rejections: readonly DriftRejection[];
  /** 파일 수 상한 초과 여부 (class=APP_TOUCHING의 원인 중 하나) */
  readonly exceedsMaxFiles: boolean;
}

export interface DriftOptions {
  /** 승인 PLAN의 context evidence / allowedPaths 등, drift가 겹치면 안 되는 경로 */
  readonly protectedPaths?: readonly string[];
}

function sortedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

/**
 * pure. 입력 파일 목록을 정책으로 분류한다.
 * 결과가 FRAMEWORK_ONLY가 아니면 rejections에 이유가 남는다.
 */
export function classifyDrift(
  files: readonly DriftFile[],
  policy: DriftPolicy,
  options: DriftOptions = {},
): DriftClassification {
  const changedPaths = sortedUnique(files.map((file) => file.path));
  if (files.length === 0) {
    return {
      policyId: policy.id,
      class: policy.allowEmpty ? "NONE" : "APP_TOUCHING",
      changedPaths,
      rejections: [],
      exceedsMaxFiles: false,
    };
  }

  const protectedSet = new Set(options.protectedPaths ?? []);
  const rejections: DriftRejection[] = [];
  for (const file of files) {
    if (!policy.allowedStatuses.includes(file.status)) {
      rejections.push({ path: file.path, reason: "STATUS_NOT_ALLOWED" });
      continue;
    }
    if (file.previousPath !== undefined) {
      rejections.push({ path: file.path, reason: "RENAMED" });
      continue;
    }
    if (!policy.isFrameworkPath(file.path)) {
      rejections.push({ path: file.path, reason: "PATH_NOT_FRAMEWORK" });
      continue;
    }
    if (protectedSet.has(file.path)) {
      rejections.push({ path: file.path, reason: "OVERLAPS_PROTECTED_PATH" });
    }
  }

  const exceedsMaxFiles = files.length > policy.maxFiles;
  const cls: DriftClass = rejections.length === 0 && !exceedsMaxFiles ? "FRAMEWORK_ONLY" : "APP_TOUCHING";
  return { policyId: policy.id, class: cls, changedPaths, rejections, exceedsMaxFiles };
}

// ---------------------------------------------------------------------------
// 현재 repo에 존재하는 5개 정책의 데이터 스냅샷 (판정 동일성은 parity 테스트로 고정)
// ---------------------------------------------------------------------------

const ADDED_OR_MODIFIED: readonly DriftFileStatus[] = Object.freeze(["added", "modified"]);

/** ① plan-implement-handoff.ts `frameworkOnlyRebindPath` + PLAN_REBIND_MAX_DRIFT_FILES */
export const REBIND_DRIFT_POLICY: DriftPolicy = Object.freeze({
  id: "plan-rebind-v1",
  maxFiles: 16,
  allowEmpty: false,
  allowedStatuses: ADDED_OR_MODIFIED,
  isFrameworkPath: (path: string) =>
    path.startsWith("src/self-improvement/") ||
    path.startsWith(".github/workflows/") ||
    path.startsWith("test/"),
});

/** ② plan-worker-recovery-preflight.yml `allowedFiles` (files.length > 12 거부) */
export const WORKER_RECOVERY_PREFLIGHT_DRIFT_FILES: readonly string[] = Object.freeze([
  ".github/workflows/plan-implement-worker.yml",
  ".github/workflows/plan-candidate-bridge.yml",
  ".github/workflows/plan-worker-recovery-preflight.yml",
  "src/self-improvement/plan-implement-worker-handler.ts",
  "src/self-improvement/plan-implement-worker.ts",
  "src/self-improvement/plan-candidate-bridge-handler.ts",
  "src/self-improvement/plan-candidate-bridge.ts",
  "test/plan-implement-worker-workflow.test.ts",
  "test/plan-candidate-bridge-workflow.test.ts",
  "test/plan-candidate-bridge.test.ts",
  "test/plan-implement-worker.test.ts",
  "test/plan-worker-recovery-preflight-workflow.test.ts",
]);

export const WORKER_RECOVERY_PREFLIGHT_DRIFT_POLICY: DriftPolicy = Object.freeze({
  id: "worker-recovery-preflight-v1",
  maxFiles: 12,
  allowEmpty: true,
  allowedStatuses: ADDED_OR_MODIFIED,
  isFrameworkPath: (path: string) => WORKER_RECOVERY_PREFLIGHT_DRIFT_FILES.includes(path),
});

/** ③ plan-candidate-bridge.yml recovery guard (files.length > 50 거부) */
export const BRIDGE_RECOVERY_FRAMEWORK_ROOT_TESTS: readonly string[] = Object.freeze([
  "test/orchestrator-workflow.test.ts",
  "test/plan-candidate-bridge-workflow.test.ts",
  "test/plan-candidate-bridge.test.ts",
  "test/fix-dispatch-workflow.test.ts",
  "test/plan-candidate-bridge-recovery-finalize.test.ts",
  "test/plan-candidate-bridge-recovery-provenance.test.ts",
  "test/plan-implement-worker-workflow.test.ts",
  "test/plan-implement-worker.test.ts",
  "test/plan-worker-recovery-preflight-workflow.test.ts",
  "test/plan-trusted-rail-recovery-source.test.ts",
  "test/review-workflow.test.ts",
  "test/seal-workflow.test.ts",
]);

const BRIDGE_RECOVERY_FRAMEWORK_DOC =
  /^docs\/(?:self-improvement\/|(?:architecture|trust-model|state-machine|phase-[1-6]-[^/]+|orchestrator-smoke|fix-loop-smoke-[^/]+)\.md$)/;

export const BRIDGE_RECOVERY_DRIFT_POLICY: DriftPolicy = Object.freeze({
  id: "candidate-bridge-recovery-v1",
  maxFiles: 50,
  allowEmpty: true,
  allowedStatuses: ADDED_OR_MODIFIED,
  isFrameworkPath: (path: string) =>
    path.startsWith(".github/workflows/") ||
    path.startsWith("src/self-improvement/") ||
    path === "FRAMEWORK.md" ||
    BRIDGE_RECOVERY_FRAMEWORK_DOC.test(path) ||
    path.startsWith("test/self-improvement/") ||
    BRIDGE_RECOVERY_FRAMEWORK_ROOT_TESTS.includes(path),
});

/** ④ trusted-rail.yml PLAN_BRIDGE recovery (files.length > 8 거부) */
export const TRUSTED_RAIL_RECOVERY_DRIFT_FILES: readonly string[] = Object.freeze([
  ".github/workflows/trusted-rail.yml",
  ".github/workflows/semantic-review.yml",
  "test/plan-trusted-rail-recovery-source.test.ts",
  "test/review-workflow.test.ts",
]);

export const TRUSTED_RAIL_RECOVERY_DRIFT_POLICY: DriftPolicy = Object.freeze({
  id: "trusted-rail-plan-bridge-recovery-v1",
  maxFiles: 8,
  allowEmpty: true,
  allowedStatuses: ADDED_OR_MODIFIED,
  isFrameworkPath: (path: string) => TRUSTED_RAIL_RECOVERY_DRIFT_FILES.includes(path),
});

/** ⑤ plan-authorize / plan-recovery: allowlist 없음. SHA가 다르면 무조건 재-PLAN. */
export const NO_DRIFT_POLICY: DriftPolicy = Object.freeze({
  id: "plan-authorize-no-drift-v1",
  maxFiles: 0,
  allowEmpty: true,
  allowedStatuses: Object.freeze([]),
  isFrameworkPath: () => false,
});

export const DRIFT_POLICIES: readonly DriftPolicy[] = Object.freeze([
  REBIND_DRIFT_POLICY,
  WORKER_RECOVERY_PREFLIGHT_DRIFT_POLICY,
  BRIDGE_RECOVERY_DRIFT_POLICY,
  TRUSTED_RAIL_RECOVERY_DRIFT_POLICY,
  NO_DRIFT_POLICY,
]);

/** 같은 파일 목록을 모든 정책으로 분류해 stage 간 판정 차이를 한눈에 본다 (진단용, pure). */
export function classifyDriftAcrossPolicies(
  files: readonly DriftFile[],
  options: DriftOptions = {},
): Readonly<Record<string, DriftClass>> {
  const result: Record<string, DriftClass> = {};
  for (const policy of DRIFT_POLICIES) result[policy.id] = classifyDrift(files, policy, options).class;
  return Object.freeze(result);
}
