/**
 * Canonical Execution Lineage — Effective Base SHA.
 *
 * 현재 코드는 `rebind?.reboundTargetSha ?? authorization.targetSha` 식을
 * plan-implement-handoff.ts(2곳), plan-implement-worker.ts, plan-candidate-bridge.ts에서
 * 각각 계산한다. 이 모듈은 그 계산을 하나의 pure function으로 고정한다.
 *
 * Step 1A에서는 기존 호출부를 바꾸지 않는다. 기존 파생값과 같다는 것을 parity 테스트로 증명한다.
 */
import { GIT_SHA } from "./constants.js";

export type EffectiveBaseKind = "APPROVED" | "REBOUND";

export interface ApprovedTargetLike {
  readonly targetSha: string;
}

export interface RebindLike {
  readonly sourceTargetSha: string;
  readonly reboundTargetSha: string;
}

export interface EffectiveBase {
  /** 실제 checkout/CI/patch의 base. downstream은 이 값만 본다. */
  readonly sha: string;
  readonly kind: EffectiveBaseKind;
  /** Human이 승인한 시점의 SHA. kind=APPROVED면 sha와 같다. */
  readonly approvedSha: string;
}

function assertSha(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) {
    throw new Error(`${name} must be a lowercase Git commit SHA`);
  }
}

/**
 * 승인 SHA와 (선택) rebind provenance로 유효 base를 결정한다.
 * - rebind가 없으면 승인 SHA 그대로 (APPROVED)
 * - rebind가 있으면 rebind.sourceTargetSha가 승인 SHA와 같아야 하고, rebound SHA는 달라야 한다 (REBOUND)
 */
export function effectiveBase(approved: ApprovedTargetLike, rebind?: RebindLike): EffectiveBase {
  assertSha("approved target SHA", approved.targetSha);
  if (rebind === undefined) {
    return { sha: approved.targetSha, kind: "APPROVED", approvedSha: approved.targetSha };
  }
  assertSha("rebind source target SHA", rebind.sourceTargetSha);
  assertSha("rebind rebound target SHA", rebind.reboundTargetSha);
  if (rebind.sourceTargetSha !== approved.targetSha) {
    throw new Error("rebind source target SHA does not match approved target SHA");
  }
  if (rebind.reboundTargetSha === approved.targetSha) {
    throw new Error("rebind requires a moved target SHA");
  }
  return { sha: rebind.reboundTargetSha, kind: "REBOUND", approvedSha: approved.targetSha };
}

/**
 * control-plane 코드 SHA와 base SHA의 관계.
 * 현재 코드는 "recovery guard가 없으면 둘이 같아야 한다"를 여러 곳에서 가정한다.
 * 이 함수는 그 가정을 이름 있는 판정으로 만든다 (판정 자체는 기존과 동일).
 */
export type ControlPlaneRelation = "SAME_AS_BASE" | "AHEAD_OF_BASE";

export function controlPlaneRelation(baseSha: string, controlPlaneSha: string): ControlPlaneRelation {
  assertSha("base SHA", baseSha);
  assertSha("control-plane SHA", controlPlaneSha);
  return baseSha === controlPlaneSha ? "SAME_AS_BASE" : "AHEAD_OF_BASE";
}
