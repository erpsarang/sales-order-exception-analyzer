/**
 * Canonical Execution Lineage — trigger / source vocabulary.
 *
 * 목표: downstream stage가 GitHub raw event(`workflow_run`, `issue_comment`, ...)를
 * 직접 해석하지 않고, 정규화된 Trigger만 보게 한다.
 *
 * Step 1A에서는 vocabulary와 정규화 pure function만 추가한다.
 * STAGE_PRODUCERS 표는 "현재 코드가 실제로 허용하는 조합"을 그대로 옮긴 것이며,
 * 현재 stage 간 불일치(P1/P2)도 그대로 기록한다. 통합은 후속 단계에서 한다.
 */
import { WORKFLOWS, type WorkflowKey } from "./constants.js";

export type LineageStage =
  | "plan"
  | "plan-authorize"
  | "plan-recovery"
  | "handoff"
  | "worker"
  | "worker-recovery-preflight"
  | "bridge"
  | "seal"
  | "publish"
  | "verify";

/** downstream이 소비하는 정규화된 trigger. GitHub event 이름을 여기서 끊는다. */
export type LineageTrigger =
  | "REQUIREMENT_ISSUE"    // issues: [업무 요구] Issue opened/reopened → PLAN
  | "MANUAL_DISPATCH"      // workflow_dispatch by human → PLAN, Recovery Preflight
  | "AUTO_REPLAN"          // workflow_dispatch by plan-recovery → PLAN
  | "HUMAN_APPROVAL"       // issue_comment "PLAN-승인" → PLAN_AUTHORIZE
  | "REBIND_REQUEST"       // issue_comment "PLAN-재개" → Handoff (rebind)
  | "UPSTREAM_COMPLETION"  // workflow_run(completed, success) of the expected upstream
  | "RECOVERY_PREFLIGHT"   // workflow_run of Trusted Worker Recovery Preflight → Worker
  | "EXPLICIT_RECOVERY";   // workflow_dispatch with exact source identity → Bridge / Rail

export type GitHubEventName = "issues" | "workflow_dispatch" | "issue_comment" | "workflow_run";

export interface RawSourceEvent {
  readonly stage: LineageStage;
  readonly githubEvent: GitHubEventName;
  /** workflow_run일 때 상류 workflow path */
  readonly upstreamWorkflowPath?: string;
  /** issue_comment일 때 comment 본문 */
  readonly commentBody?: string;
  /** workflow_dispatch일 때 dispatch를 만든 주체 */
  readonly dispatchedBy?: "human" | "plan-recovery" | "candidate-bridge";
}

export interface ProducerRule {
  readonly githubEvent: GitHubEventName;
  readonly trigger: LineageTrigger;
  readonly upstream?: WorkflowKey;
  readonly commentBody?: string;
  readonly dispatchedBy?: RawSourceEvent["dispatchedBy"];
}

export interface StageProducer {
  readonly workflow: WorkflowKey;
  readonly rules: readonly ProducerRule[];
}

/**
 * 현재 코드가 허용하는 (stage, GitHub event, upstream) 조합.
 * 출처: 각 workflow `on:`/`if:` 및 handler의 event 검사.
 */
export const STAGE_PRODUCERS: Readonly<Record<LineageStage, StageProducer>> = Object.freeze({
  plan: {
    workflow: "plan",
    rules: [
      { githubEvent: "issues", trigger: "REQUIREMENT_ISSUE" },
      { githubEvent: "workflow_dispatch", trigger: "MANUAL_DISPATCH", dispatchedBy: "human" },
      { githubEvent: "workflow_dispatch", trigger: "AUTO_REPLAN", dispatchedBy: "plan-recovery" },
    ],
  },
  "plan-authorize": {
    workflow: "planAuthorize",
    rules: [{ githubEvent: "issue_comment", trigger: "HUMAN_APPROVAL", commentBody: "PLAN-승인" }],
  },
  "plan-recovery": {
    workflow: "planRecovery",
    rules: [{ githubEvent: "workflow_run", trigger: "UPSTREAM_COMPLETION", upstream: "planAuthorize" }],
  },
  handoff: {
    workflow: "planImplementHandoff",
    rules: [
      { githubEvent: "workflow_run", trigger: "UPSTREAM_COMPLETION", upstream: "planAuthorize" },
      { githubEvent: "issue_comment", trigger: "REBIND_REQUEST", commentBody: "PLAN-재개" },
    ],
  },
  worker: {
    workflow: "planImplementWorker",
    rules: [
      { githubEvent: "workflow_run", trigger: "UPSTREAM_COMPLETION", upstream: "planImplementHandoff" },
      { githubEvent: "workflow_run", trigger: "RECOVERY_PREFLIGHT", upstream: "planWorkerRecoveryPreflight" },
    ],
  },
  "worker-recovery-preflight": {
    workflow: "planWorkerRecoveryPreflight",
    rules: [{ githubEvent: "workflow_dispatch", trigger: "MANUAL_DISPATCH", dispatchedBy: "human" }],
  },
  bridge: {
    workflow: "planCandidateBridge",
    rules: [
      { githubEvent: "workflow_run", trigger: "UPSTREAM_COMPLETION", upstream: "planImplementWorker" },
      { githubEvent: "workflow_dispatch", trigger: "EXPLICIT_RECOVERY", dispatchedBy: "human" },
    ],
  },
  seal: {
    workflow: "trustedRail",
    rules: [
      { githubEvent: "workflow_dispatch", trigger: "UPSTREAM_COMPLETION", dispatchedBy: "candidate-bridge" },
      { githubEvent: "workflow_dispatch", trigger: "EXPLICIT_RECOVERY", dispatchedBy: "human" },
    ],
  },
  publish: { workflow: "trustedRail", rules: [] },
  verify: { workflow: "trustedRail", rules: [] },
});

/** 각 stage의 직전 stage (lineage chain 순서). Rail 내부 job은 같은 run 안에서 이어진다. */
export const STAGE_ORDER: readonly LineageStage[] = Object.freeze([
  "plan",
  "plan-authorize",
  "handoff",
  "worker",
  "bridge",
  "seal",
  "publish",
  "verify",
]);

export function stageIndex(stage: LineageStage): number {
  const index = STAGE_ORDER.indexOf(stage);
  if (index < 0) throw new Error(`stage is not part of the main lineage chain: ${stage}`);
  return index;
}

export function isNextStage(previous: LineageStage, next: LineageStage): boolean {
  return stageIndex(next) === stageIndex(previous) + 1;
}

/**
 * GitHub raw event → LineageTrigger 정규화 (pure).
 * 허용되지 않는 조합은 throw. downstream은 이 함수의 결과만 소비한다.
 */
export function normalizeTrigger(event: RawSourceEvent): LineageTrigger {
  const producer = STAGE_PRODUCERS[event.stage];
  for (const rule of producer.rules) {
    if (rule.githubEvent !== event.githubEvent) continue;
    if (rule.upstream !== undefined) {
      if (event.upstreamWorkflowPath !== WORKFLOWS[rule.upstream].path) continue;
    }
    if (rule.commentBody !== undefined && rule.commentBody !== event.commentBody) continue;
    if (rule.dispatchedBy !== undefined && rule.dispatchedBy !== event.dispatchedBy) continue;
    return rule.trigger;
  }
  throw new Error(
    `no producer rule for stage=${event.stage} event=${event.githubEvent}` +
      (event.upstreamWorkflowPath ? ` upstream=${event.upstreamWorkflowPath}` : "") +
      (event.commentBody ? ` comment=${JSON.stringify(event.commentBody)}` : "") +
      (event.dispatchedBy ? ` dispatchedBy=${event.dispatchedBy}` : ""),
  );
}

/**
 * 어떤 stage가 "상류 run의 event"로 무엇을 받아들이는지에 대한 현재 코드의 사실.
 * key = 검사하는 쪽, value = 상류 run에 허용된 GitHub event.
 *
 * 불일치가 그대로 보인다:
 *  - PLAN run: authorize/handoff는 [workflow_dispatch, issues], plan-recovery는 [workflow_dispatch]만 (P1)
 *  - Handoff run: worker/bridge는 [workflow_run, issue_comment], preflight는 [workflow_run]만 (P2)
 */
export const UPSTREAM_EVENT_ACCEPTANCE = Object.freeze({
  planRunAcceptedBy: Object.freeze({
    planAuthorizeHandler: ["workflow_dispatch", "issues"],
    planImplementHandoffHandler: ["workflow_dispatch", "issues"],
    planRecoveryClassifier: ["workflow_dispatch"],
  } as const),
  handoffRunAcceptedBy: Object.freeze({
    planImplementWorkerWorkflow: ["workflow_run", "issue_comment"],
    planImplementWorkerLibrary: Object.freeze({ withRebind: ["issue_comment"], withoutRebind: ["workflow_run"] }),
    planCandidateBridgeWorkflow: ["workflow_run", "issue_comment"],
    planWorkerRecoveryPreflightWorkflow: ["workflow_run"],
  } as const),
  workerRunAcceptedBy: Object.freeze({
    planCandidateBridge: ["workflow_run"],
    trustedRailPlanBridge: ["workflow_run", "workflow_dispatch"],
  } as const),
} as const);

/** PLAN workflow가 정상적으로 시작될 수 있는 GitHub event의 canonical 집합. */
export const PLAN_TRIGGER_EVENTS: readonly GitHubEventName[] = Object.freeze(["workflow_dispatch", "issues"]);
