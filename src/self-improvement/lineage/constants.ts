/**
 * Canonical Execution Lineage — 공통 상수.
 *
 * Step 1A: 기존 파일들이 각자 정의한 workflow name/path, SHA/digest 정규식,
 * artifact 이름 규칙을 한 곳에 모은다. 기존 export는 그대로 두고, 이 모듈과
 * 기존 값이 같다는 것을 parity 테스트로 고정한다. (기존 동작 변경 없음)
 */

export const GIT_SHA = /^[0-9a-f]{40,64}$/;
export const GIT_SHA_EXACT_40 = /^[0-9a-f]{40}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/;

export type WorkflowKey =
  | "plan"
  | "planAuthorize"
  | "planRecovery"
  | "planImplementHandoff"
  | "planImplementWorker"
  | "planWorkerRecoveryPreflight"
  | "planCandidateBridge"
  | "trustedRail"
  | "semanticReview"
  | "orchestrator";

export interface WorkflowIdentity {
  readonly name: string;
  readonly path: string;
}

export const WORKFLOWS: Readonly<Record<WorkflowKey, WorkflowIdentity>> = Object.freeze({
  plan: { name: "Read-only AI PLAN", path: ".github/workflows/plan.yml" },
  planAuthorize: { name: "Trusted PLAN_AUTHORIZE", path: ".github/workflows/plan-authorize.yml" },
  planRecovery: { name: "Trusted PLAN Recovery", path: ".github/workflows/plan-recovery.yml" },
  planImplementHandoff: {
    name: "Trusted PLAN IMPLEMENT Handoff",
    path: ".github/workflows/plan-implement-handoff.yml",
  },
  planImplementWorker: {
    name: "PLAN Bounded IMPLEMENT Worker",
    path: ".github/workflows/plan-implement-worker.yml",
  },
  planWorkerRecoveryPreflight: {
    name: "Trusted Worker Recovery Preflight",
    path: ".github/workflows/plan-worker-recovery-preflight.yml",
  },
  planCandidateBridge: {
    name: "Trusted PLAN Candidate Bridge",
    path: ".github/workflows/plan-candidate-bridge.yml",
  },
  trustedRail: { name: "Trusted Rail", path: ".github/workflows/trusted-rail.yml" },
  semanticReview: { name: "Semantic REVIEW", path: ".github/workflows/semantic-review.yml" },
  orchestrator: { name: "Embedded Orchestrator", path: ".github/workflows/orchestrator.yml" },
});

export function workflowByPath(path: string): WorkflowKey | undefined {
  for (const key of Object.keys(WORKFLOWS) as WorkflowKey[]) {
    if (WORKFLOWS[key].path === path) return key;
  }
  return undefined;
}

/** Human 승인/재개 comment 본문 (exact match). */
export const HUMAN_COMMENTS = Object.freeze({
  planApproval: "PLAN-승인",
  planRebind: "PLAN-재개",
} as const);

/**
 * artifact 이름 규칙. 이름은 "위치 지정용"이며 identity의 근거는 provenance 본문이다.
 * 기존 builder 함수 출력과 일치함을 parity 테스트로 고정한다.
 */
export const ARTIFACT_NAME_PATTERNS = Object.freeze({
  plan: /^plan-issue-(\d+)-(\d+)-attempt-(\d+)$/,
  planProvenance: /^plan-issue-(\d+)-(\d+)-attempt-(\d+)-provenance$/,
  planAuthorize: /^plan-authorize-issue-(\d+)-plan-(\d+)-attempt-(\d+)-approval-(\d+)-run-(\d+)-attempt-(\d+)$/,
  implementContract: /^implement-contract-issue-(\d+)-plan-(\d+)-attempt-(\d+)-approval-(\d+)$/,
  planImplementHandoff: /^plan-implement-handoff-issue-(\d+)-plan-(\d+)-attempt-(\d+)-approval-(\d+)$/,
  workerCandidate:
    /^bounded-worker-candidate-issue-(\d+)-plan-(\d+)-approval-(\d+)-handoff-(\d+)-attempt-(\d+)-worker-(\d+)-attempt-(\d+)$/,
  workerAiCallLedger: /^bounded-worker-ai-call-([0-9a-f]{64})$/,
  workerRecoveryReady: /^worker-recovery-ready-issue-(\d+)-run-(\d+)-attempt-(\d+)$/,
  planBridgeCandidate: /^plan-bridge-candidate-issue-(\d+)-worker-(\d+)-attempt-(\d+)-bridge-(\d+)-attempt-(\d+)$/,
} as const);

/** 기존 bounded 상수 (값 복제; 기존 export와의 동일성은 parity 테스트로 고정). */
export const BOUNDS = Object.freeze({
  planImplementMaxFiles: 8,
  planImplementMaxContextBytes: 80_000,
  planImplementMaxPatchBytes: 80_000,
  planRebindMaxDriftFiles: 16,
  maxAutoReplanPerAuthorization: 2,
  maxBoundedRepairAttempts: 2,
} as const);
