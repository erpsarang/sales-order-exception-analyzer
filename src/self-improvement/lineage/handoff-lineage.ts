/**
 * Canonical Execution Lineage — Step 2A: Handoff shadow lineage.
 *
 * Trusted PLAN IMPLEMENT Handoff가 이미 가지고 있는 trusted 정보만으로
 * LineageRoot + 첫 StageProvenance(handoff)를 만든다 (pure).
 *
 * shadow only:
 *  - 기존 Handoff artifact(contract/context/prompt/schema/handoff/source)의 내용과 digest는 바꾸지 않는다.
 *  - lineage는 기존 manifest의 handoffDigest를 "참조"만 하므로 manifest 뒤에 계산되며 순환 의존이 없다.
 *  - 어떤 downstream stage도 아직 이 값을 읽지 않는다.
 *
 * 기존 LineageRoot / StageProvenance schema와 digest algorithm을 그대로 재사용한다.
 */
import { verifyImplementContract, type ImplementContract } from "../implement-contract.js";
import type { PlanAuthorizeArtifact } from "../plan-authorization.js";
import {
  createPlanImplementHandoffManifest,
  verifyPlanAuthorizeArtifact,
  verifyPlanRebindProvenance,
  type PlanImplementHandoffManifest,
  type PlanRebindProvenance,
} from "../plan-implement-handoff.js";
import { effectiveBase } from "./base.js";
import { GIT_SHA, SHA256, WORKFLOWS } from "./constants.js";
import {
  canonicalJson,
  createLineageRoot,
  createStageProvenance,
  verifyLineageRoot,
  verifyStageProvenance,
  type LineageRoot,
  type StageProvenance,
} from "./provenance.js";
import { normalizeTrigger, type LineageTrigger } from "./sources.js";

export const HANDOFF_LINEAGE_FILE = "lineage.json" as const;
export const HANDOFF_LINEAGE_ARTIFACT_SUFFIX = "-lineage" as const;

/** `lineage.json`의 최소 구조: 기존 root와 handoff stage record를 그대로 담는다. */
export interface HandoffLineage {
  readonly schemaVersion: 1;
  readonly kind: "execution-lineage-handoff-shadow";
  readonly root: LineageRoot;
  readonly handoff: StageProvenance;
}

export interface HandoffProducerIdentity {
  readonly runId: number;
  readonly runAttempt: number;
  /** 실제 checkout되어 실행된 trusted control-plane SHA */
  readonly controlPlaneSha: string;
}

export interface CreateHandoffLineageInput {
  readonly authorization: PlanAuthorizeArtifact;
  readonly rebind?: PlanRebindProvenance;
  readonly contract: ImplementContract;
  readonly contextDigest: string;
  readonly manifest: PlanImplementHandoffManifest;
  readonly trigger: LineageTrigger;
  readonly producer: HandoffProducerIdentity;
}

/** Handoff workflow run의 GitHub event를 canonical trigger로 정규화한다 (pure). */
export function handoffTriggerFromGitHubEvent(githubEvent: string): LineageTrigger {
  if (githubEvent === "workflow_run") {
    return normalizeTrigger({ stage: "handoff", githubEvent, upstreamWorkflowPath: WORKFLOWS.planAuthorize.path });
  }
  if (githubEvent === "issue_comment") {
    return normalizeTrigger({ stage: "handoff", githubEvent, commentBody: "PLAN-재개" });
  }
  throw new Error(`unsupported Handoff GitHub event for lineage: ${githubEvent}`);
}

/** Handoff artifact 이름에서 shadow lineage sibling artifact 이름을 만든다. */
export function handoffLineageArtifactName(handoffArtifactName: string): string {
  if (!/^plan-implement-handoff-issue-\d+-plan-\d+-attempt-\d+-approval-\d+$/.test(handoffArtifactName)) {
    throw new Error("Handoff artifact name is invalid");
  }
  return `${handoffArtifactName}${HANDOFF_LINEAGE_ARTIFACT_SUFFIX}`;
}

export function createHandoffLineage(input: CreateHandoffLineageInput): HandoffLineage {
  const authorization = verifyPlanAuthorizeArtifact(input.authorization);
  const rebind = input.rebind === undefined ? undefined : verifyPlanRebindProvenance(input.rebind, authorization);
  verifyImplementContract(input.contract);
  if (typeof input.contextDigest !== "string" || !SHA256.test(input.contextDigest)) {
    throw new Error("Handoff lineage contextDigest must be a lowercase SHA-256 digest");
  }

  // 기존 manifest와 exact binding: 같은 입력으로 다시 만든 manifest와 byte-identical해야 한다.
  const expectedManifest = createPlanImplementHandoffManifest({
    authorization,
    sourceArtifact: input.manifest.sourcePlanAuthorize.artifact,
    contract: input.contract,
    contextDigest: input.contextDigest,
    ...(rebind ? { rebind } : {}),
  });
  if (JSON.stringify(expectedManifest) !== JSON.stringify(input.manifest)) {
    throw new Error("Handoff lineage manifest does not match authorization/contract/context/rebind");
  }

  // effective base는 기존 동작과 exact parity.
  const base = effectiveBase(authorization, rebind);
  if (base.sha !== input.contract.baseSha || base.sha !== expectedManifest.baseSha) {
    throw new Error("Handoff lineage effective base does not match contract/manifest baseSha");
  }

  // trigger와 rebind 여부는 항상 함께 간다 (기존 Worker library 규칙과 동일한 의미).
  const expectedTrigger: LineageTrigger = rebind ? "REBIND_REQUEST" : "UPSTREAM_COMPLETION";
  if (input.trigger !== expectedTrigger) {
    throw new Error(`Handoff lineage trigger must be ${expectedTrigger} for ${base.kind} base`);
  }

  // Handoff에서는 trusted control-plane SHA가 effective base와 같다
  // (normal: PLAN_AUTHORIZE head SHA == targetSha, rebind: exact current default == reboundTargetSha).
  if (typeof input.producer.controlPlaneSha !== "string" || !GIT_SHA.test(input.producer.controlPlaneSha)) {
    throw new Error("Handoff lineage controlPlaneSha must be a Git SHA");
  }
  if (input.producer.controlPlaneSha !== base.sha) {
    throw new Error("Handoff lineage controlPlaneSha must equal the effective base SHA");
  }

  const root = createLineageRoot({
    repository: authorization.repository,
    issueNumber: authorization.requirement.issueNumber,
    requirementDigest: authorization.requirement.digest,
    plan: {
      runId: authorization.plan.runId,
      runAttempt: authorization.plan.runAttempt,
      targetSha: authorization.targetSha,
      artifact: { ...authorization.plan.artifact },
      provenanceArtifact: { ...authorization.plan.provenanceArtifact },
    },
    approval: {
      commentId: authorization.approval.commentId,
      approverUserId: authorization.approval.approverUserId,
      authorizationDigest: authorization.authorizationDigest,
    },
    base: {
      sha: base.sha,
      kind: base.kind,
      ...(rebind ? { rebindDigest: rebind.rebindDigest } : {}),
    },
  });

  const handoff = createStageProvenance({
    root,
    stage: "handoff",
    trigger: input.trigger,
    producer: {
      workflowPath: WORKFLOWS.planImplementHandoff.path,
      runId: input.producer.runId,
      runAttempt: input.producer.runAttempt,
      controlPlaneSha: input.producer.controlPlaneSha,
    },
    subject: {
      digests: {
        contractDigest: input.contract.contractDigest,
        contextDigest: input.contextDigest,
        handoffDigest: expectedManifest.handoffDigest,
      },
    },
  });

  return { schemaVersion: 1, kind: "execution-lineage-handoff-shadow", root, handoff };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 외부 JSON(`lineage.json`)을 fail-closed로 검증한다. */
export function verifyHandoffLineage(value: unknown): HandoffLineage {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "execution-lineage-handoff-shadow") {
    throw new Error("unsupported Handoff lineage schema");
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["handoff", "kind", "root", "schemaVersion"])) {
    throw new Error("Handoff lineage shape is invalid");
  }
  const root = verifyLineageRoot(value.root);
  const handoff = verifyStageProvenance(value.handoff, { root });
  if (handoff.stage !== "handoff") throw new Error("Handoff lineage stage must be handoff");
  const expectedTrigger: LineageTrigger = root.base.kind === "REBOUND" ? "REBIND_REQUEST" : "UPSTREAM_COMPLETION";
  if (handoff.trigger !== expectedTrigger) {
    throw new Error(`Handoff lineage trigger must be ${expectedTrigger} for ${root.base.kind} base`);
  }
  if (handoff.producer.controlPlaneSha !== root.base.sha) {
    throw new Error("Handoff lineage controlPlaneSha must equal the effective base SHA");
  }
  for (const key of ["contractDigest", "contextDigest", "handoffDigest"]) {
    if (typeof handoff.subject.digests[key] !== "string") throw new Error(`Handoff lineage subject is missing ${key}`);
  }
  const lineage: HandoffLineage = { schemaVersion: 1, kind: "execution-lineage-handoff-shadow", root, handoff };
  if (canonicalJson(lineage) !== canonicalJson(value)) throw new Error("Handoff lineage has unexpected fields");
  return lineage;
}
