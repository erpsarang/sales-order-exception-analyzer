import type { PlanAuthorizeArtifact } from "./plan-authorization.js";

const GIT_SHA = /^[0-9a-f]{40,64}$/;

export const PLAN_WORKFLOW_PATH = ".github/workflows/plan.yml" as const;

export type PlanRecoveryReason =
  | "NONE"
  | "DEFAULT_BRANCH_MOVED"
  | "PLAN_CONTROL_PLANE_STALE";

export interface PlanRunObservation {
  readonly name: string;
  readonly path: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly runAttempt: number;
  readonly headBranch: string;
  readonly headSha: string;
}

export interface PlanRecoveryDecision {
  readonly required: boolean;
  readonly reason: PlanRecoveryReason;
}

function validSha(name: string, value: string): void {
  if (!GIT_SHA.test(value)) throw new Error(`${name} is invalid`);
}

export function classifyPlanRecovery(
  authorization: PlanAuthorizeArtifact,
  planRun: PlanRunObservation,
  defaultBranch: string,
  currentDefaultSha: string,
): PlanRecoveryDecision {
  if (!defaultBranch.trim()) throw new Error("default branch missing");
  validSha("approved PLAN target SHA", authorization.targetSha);
  validSha("PLAN workflow head SHA", planRun.headSha);
  validSha("current default SHA", currentDefaultSha);

  if (
    planRun.name !== "Read-only AI PLAN" ||
    planRun.path !== PLAN_WORKFLOW_PATH ||
    planRun.event !== "workflow_dispatch" ||
    planRun.status !== "completed" ||
    planRun.conclusion !== "success" ||
    planRun.headBranch !== defaultBranch ||
    planRun.runAttempt !== authorization.plan.runAttempt
  ) {
    throw new Error("approved PLAN workflow identity is invalid for automatic recovery");
  }

  if (currentDefaultSha !== authorization.targetSha) {
    return { required: true, reason: "DEFAULT_BRANCH_MOVED" };
  }

  if (planRun.headSha !== authorization.targetSha) {
    return { required: true, reason: "PLAN_CONTROL_PLANE_STALE" };
  }

  return { required: false, reason: "NONE" };
}
