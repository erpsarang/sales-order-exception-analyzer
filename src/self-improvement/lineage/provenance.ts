/**
 * Canonical Execution Lineage — root + immutable stage provenance chain.
 *
 * 설계 선택: 하나의 계속 커지는 `stages[]` 객체 대신,
 *   - LineageRoot: Handoff가 한 번 만들고 다시는 바뀌지 않는 root
 *   - StageProvenance: 각 stage가 한 번 발행하는 작은 record, `parentLineageDigest`로 직전 record에 연결
 * 을 쓴다.
 *
 * 이유:
 *   1. 각 stage는 자기 run에서 자기 artifact만 업로드한다. 누적 배열이면 모든 stage가
 *      전체 이력을 다시 쓰고 다시 서명해야 하고, "같은 lineage"의 digest가 stage마다 바뀐다.
 *   2. retry/repair/recovery는 같은 parent를 가리키는 형제 record가 된다(fan-out).
 *      누적 배열은 이런 분기를 표현하기 어렵다.
 *   3. record 하나만 있어도 root digest + parent digest로 자기 위치를 증명할 수 있다.
 *
 * Step 1A: 자료구조와 create/verify pure function만 추가. 어떤 workflow도 아직 발행하지 않는다.
 */
import { createHash } from "node:crypto";
import { GIT_SHA, SHA256 } from "./constants.js";
import type { EffectiveBaseKind } from "./base.js";
import { isNextStage, type LineageStage, type LineageTrigger } from "./sources.js";

export interface ArtifactRef {
  readonly name: string;
  readonly id: number;
  readonly digest: string;
}

export interface LineageRootPayload {
  readonly schemaVersion: 1;
  readonly kind: "execution-lineage-root";
  readonly repository: string;
  readonly issueNumber: number;
  readonly requirementDigest: string;
  readonly plan: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly targetSha: string;
    readonly artifact: ArtifactRef;
    readonly provenanceArtifact: ArtifactRef;
  };
  readonly approval: {
    readonly commentId: number;
    readonly approverUserId: number;
    readonly authorizationDigest: string;
  };
  readonly base: {
    readonly sha: string;
    readonly kind: EffectiveBaseKind;
    readonly rebindDigest?: string;
  };
}

export interface LineageRoot extends LineageRootPayload {
  readonly digestAlgorithm: "sha256";
  readonly rootDigest: string;
}

export interface StageProvenancePayload {
  readonly schemaVersion: 1;
  readonly kind: "execution-lineage-stage";
  readonly stage: LineageStage;
  readonly rootDigest: string;
  /** 직전 record의 lineageDigest. 첫 stage는 rootDigest. */
  readonly parentLineageDigest: string;
  readonly trigger: LineageTrigger;
  readonly producer: {
    readonly workflowPath: string;
    readonly runId: number;
    readonly runAttempt: number;
    readonly controlPlaneSha: string;
  };
  readonly subject: {
    readonly artifact?: ArtifactRef;
    /** 예: contractDigest, contextDigest, handoffDigest, candidateDigest, patchDigest */
    readonly digests: Readonly<Record<string, string>>;
  };
}

export interface StageProvenance extends StageProvenancePayload {
  readonly digestAlgorithm: "sha256";
  readonly lineageDigest: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertDigest(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function assertSha(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) throw new Error(`${name} must be a Git SHA`);
}

function assertNonempty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be non-empty`);
}

function assertArtifactRef(name: string, value: unknown): asserts value is ArtifactRef {
  if (!record(value)) throw new Error(`${name} must be an object`);
  assertNonempty(`${name}.name`, value.name);
  positiveInteger(`${name}.id`, value.id);
  assertDigest(`${name}.digest`, value.digest);
}

/**
 * 새 구조 전용 canonical JSON: 키를 재귀적으로 정렬한다.
 * (기존 provenance는 JSON.stringify 삽입 순서를 쓰며, 그 digest는 건드리지 않는다.)
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (record(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) out[key] = sortKeys(item);
    }
    return out;
  }
  return value;
}

export function lineageDigestOf(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function rootPayload(value: LineageRoot | LineageRootPayload): LineageRootPayload {
  return {
    schemaVersion: 1,
    kind: "execution-lineage-root",
    repository: value.repository,
    issueNumber: value.issueNumber,
    requirementDigest: value.requirementDigest,
    plan: {
      runId: value.plan.runId,
      runAttempt: value.plan.runAttempt,
      targetSha: value.plan.targetSha,
      artifact: { ...value.plan.artifact },
      provenanceArtifact: { ...value.plan.provenanceArtifact },
    },
    approval: { ...value.approval },
    base: {
      sha: value.base.sha,
      kind: value.base.kind,
      ...(value.base.rebindDigest === undefined ? {} : { rebindDigest: value.base.rebindDigest }),
    },
  };
}

export function createLineageRoot(input: Omit<LineageRootPayload, "schemaVersion" | "kind">): LineageRoot {
  const payload = rootPayload({ schemaVersion: 1, kind: "execution-lineage-root", ...input });
  verifyRootPayload(payload);
  return { ...payload, digestAlgorithm: "sha256", rootDigest: lineageDigestOf(payload) };
}

function verifyRootPayload(value: LineageRootPayload): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(value.repository)) throw new Error("lineage repository is invalid");
  positiveInteger("lineage issueNumber", value.issueNumber);
  assertDigest("lineage requirementDigest", value.requirementDigest);
  positiveInteger("lineage plan.runId", value.plan.runId);
  positiveInteger("lineage plan.runAttempt", value.plan.runAttempt);
  assertSha("lineage plan.targetSha", value.plan.targetSha);
  assertArtifactRef("lineage plan.artifact", value.plan.artifact);
  assertArtifactRef("lineage plan.provenanceArtifact", value.plan.provenanceArtifact);
  positiveInteger("lineage approval.commentId", value.approval.commentId);
  positiveInteger("lineage approval.approverUserId", value.approval.approverUserId);
  assertDigest("lineage approval.authorizationDigest", value.approval.authorizationDigest);
  assertSha("lineage base.sha", value.base.sha);
  if (value.base.kind === "APPROVED") {
    if (value.base.sha !== value.plan.targetSha) throw new Error("APPROVED base must equal plan target SHA");
    if (value.base.rebindDigest !== undefined) throw new Error("APPROVED base must not carry rebindDigest");
  } else if (value.base.kind === "REBOUND") {
    if (value.base.sha === value.plan.targetSha) throw new Error("REBOUND base must differ from plan target SHA");
    assertDigest("lineage base.rebindDigest", value.base.rebindDigest);
  } else {
    throw new Error("lineage base.kind is invalid");
  }
}

export function verifyLineageRoot(value: unknown): LineageRoot {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "execution-lineage-root" || value.digestAlgorithm !== "sha256") {
    throw new Error("unsupported lineage root schema");
  }
  assertDigest("lineage rootDigest", value.rootDigest);
  const root = value as unknown as LineageRoot;
  const payload = rootPayload(root);
  verifyRootPayload(payload);
  if (canonicalJson({ ...payload, digestAlgorithm: "sha256", rootDigest: root.rootDigest }) !== canonicalJson(root)) {
    throw new Error("lineage root has unexpected fields");
  }
  if (lineageDigestOf(payload) !== root.rootDigest) throw new Error("lineage root digest mismatch");
  return root;
}

function stagePayload(value: StageProvenance | StageProvenancePayload): StageProvenancePayload {
  return {
    schemaVersion: 1,
    kind: "execution-lineage-stage",
    stage: value.stage,
    rootDigest: value.rootDigest,
    parentLineageDigest: value.parentLineageDigest,
    trigger: value.trigger,
    producer: { ...value.producer },
    subject: {
      ...(value.subject.artifact === undefined ? {} : { artifact: { ...value.subject.artifact } }),
      digests: { ...value.subject.digests },
    },
  };
}

export interface CreateStageProvenanceInput {
  readonly root: LineageRoot;
  /** 직전 record. 첫 stage면 생략 (parent = root). */
  readonly parent?: StageProvenance;
  readonly stage: LineageStage;
  readonly trigger: LineageTrigger;
  readonly producer: StageProvenancePayload["producer"];
  readonly subject: StageProvenancePayload["subject"];
}

export function createStageProvenance(input: CreateStageProvenanceInput): StageProvenance {
  const root = verifyLineageRoot(input.root);
  const parent = input.parent === undefined ? undefined : verifyStageProvenance(input.parent, { root });
  const payload = stagePayload({
    schemaVersion: 1,
    kind: "execution-lineage-stage",
    stage: input.stage,
    rootDigest: root.rootDigest,
    parentLineageDigest: parent?.lineageDigest ?? root.rootDigest,
    trigger: input.trigger,
    producer: input.producer,
    subject: input.subject,
  });
  verifyStagePayload(payload, parent);
  return { ...payload, digestAlgorithm: "sha256", lineageDigest: lineageDigestOf(payload) };
}

function verifyStagePayload(value: StageProvenancePayload, parent: StageProvenance | undefined): void {
  assertDigest("stage rootDigest", value.rootDigest);
  assertDigest("stage parentLineageDigest", value.parentLineageDigest);
  assertNonempty("stage producer.workflowPath", value.producer.workflowPath);
  positiveInteger("stage producer.runId", value.producer.runId);
  positiveInteger("stage producer.runAttempt", value.producer.runAttempt);
  assertSha("stage producer.controlPlaneSha", value.producer.controlPlaneSha);
  if (value.subject.artifact !== undefined) assertArtifactRef("stage subject.artifact", value.subject.artifact);
  if (!record(value.subject.digests)) throw new Error("stage subject.digests must be an object");
  for (const [key, digest] of Object.entries(value.subject.digests)) {
    assertNonempty("stage subject.digests key", key);
    assertDigest(`stage subject.digests.${key}`, digest);
  }
  if (parent !== undefined) {
    if (parent.rootDigest !== value.rootDigest) throw new Error("stage root digest differs from parent root digest");
    if (parent.lineageDigest !== value.parentLineageDigest) throw new Error("stage parent digest mismatch");
    if (!isNextStage(parent.stage, value.stage)) {
      throw new Error(`stage order violation: ${parent.stage} -> ${value.stage}`);
    }
  } else if (value.parentLineageDigest !== value.rootDigest) {
    throw new Error("first stage must reference the root digest as parent");
  }
}

export function verifyStageProvenance(
  value: unknown,
  expected: { readonly root: LineageRoot; readonly parent?: StageProvenance },
): StageProvenance {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== "execution-lineage-stage" || value.digestAlgorithm !== "sha256") {
    throw new Error("unsupported lineage stage schema");
  }
  assertDigest("stage lineageDigest", value.lineageDigest);
  const stage = value as unknown as StageProvenance;
  const root = verifyLineageRoot(expected.root);
  if (stage.rootDigest !== root.rootDigest) throw new Error("stage does not belong to the given lineage root");
  const payload = stagePayload(stage);
  verifyStagePayload(payload, expected.parent);
  if (canonicalJson({ ...payload, digestAlgorithm: "sha256", lineageDigest: stage.lineageDigest }) !== canonicalJson(stage)) {
    throw new Error("lineage stage has unexpected fields");
  }
  if (lineageDigestOf(payload) !== stage.lineageDigest) throw new Error("lineage stage digest mismatch");
  return stage;
}

/**
 * root부터 순서대로 이어진 record 목록을 fail-closed로 검증한다.
 * (fan-out된 형제 record는 각각 자기 parent로 검증하며, 이 함수는 하나의 경로만 본다.)
 */
export function verifyLineageChain(root: unknown, stages: readonly unknown[]): {
  readonly root: LineageRoot;
  readonly stages: readonly StageProvenance[];
} {
  const trustedRoot = verifyLineageRoot(root);
  const verified: StageProvenance[] = [];
  let parent: StageProvenance | undefined;
  for (const candidate of stages) {
    const stage = verifyStageProvenance(candidate, parent ? { root: trustedRoot, parent } : { root: trustedRoot });
    verified.push(stage);
    parent = stage;
  }
  return { root: trustedRoot, stages: verified };
}
