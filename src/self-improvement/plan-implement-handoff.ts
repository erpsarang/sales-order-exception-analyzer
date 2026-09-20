import { createHash } from "node:crypto";
import {
  createImplementContract,
  validateApprovedPlanIdentity,
  type ImplementContract,
} from "./implement-contract.js";
import {
  toApprovedPlanIdentity,
  type PlanAuthorizeArtifact,
} from "./plan-authorization.js";

export const PLAN_AUTHORIZE_WORKFLOW_PATH = ".github/workflows/plan-authorize.yml" as const;
export const PLAN_WORKFLOW_PATH = ".github/workflows/plan.yml" as const;
export const PLAN_IMPLEMENT_MAX_CONTEXT_BYTES = 80_000;
export const PLAN_IMPLEMENT_MAX_PATCH_BYTES = 80_000;
export const PLAN_IMPLEMENT_MAX_FILES = 8;

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40,64}$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const TRUSTED_VALIDATION_COMMANDS = new Set(["npm test", "npm run build"]);

export interface PlanAuthorizeSourceRun {
  readonly id: number;
  readonly runAttempt: number;
  readonly repository: string;
  readonly workflowPath: string;
  readonly event: string;
  readonly conclusion: string;
  readonly headBranch: string;
  readonly defaultBranch: string;
  readonly headSha: string;
  readonly currentDefaultSha: string;
}

export interface PlanImplementationScopeInput {
  readonly ready: boolean;
  readonly allowedPaths: readonly string[];
  readonly requiredChanges: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly validationCommands: readonly string[];
}

export interface ApprovedPlanDocument {
  readonly questions: readonly string[];
  readonly approach: readonly string[];
  readonly implementationScope: PlanImplementationScopeInput;
}

export interface PlanAuthorizeArtifactMetadata {
  readonly name: string;
  readonly id: number;
  readonly digest: string;
}

export const PLAN_REBIND_MAX_DRIFT_FILES = 16 as const;

export interface PlanRebindProvenancePayload {
  readonly schemaVersion: 1;
  readonly kind: "trusted-plan-rebind";
  readonly repository: string;
  readonly issueNumber: number;
  readonly sourceAuthorizationDigest: string;
  readonly sourceTargetSha: string;
  readonly reboundTargetSha: string;
  readonly changedPaths: readonly string[];
}

export interface PlanRebindProvenance extends PlanRebindProvenancePayload {
  readonly digestAlgorithm: "sha256";
  readonly rebindDigest: string;
}

export interface PlanImplementHandoffPayload {
  readonly schemaVersion: 1;
  readonly kind: "trusted-plan-implement-handoff";
  readonly repository: string;
  readonly baseSha: string;
  readonly issueNumber: number;
  readonly sourcePlanAuthorize: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly artifact: PlanAuthorizeArtifactMetadata;
  };
  readonly approvedPlan: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly artifactName: string;
  };
  readonly approvalCommentId: number;
  readonly rebindDigest?: string;
  readonly contractDigest: string;
  readonly contextDigest: string;
}

export interface PlanImplementHandoffManifest extends PlanImplementHandoffPayload {
  readonly digestAlgorithm: "sha256";
  readonly handoffDigest: string;
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
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

function assertSafePath(path: string): void {
  if (
    !path.trim() ||
    !SAFE_PATH.test(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("*") ||
    path.includes("?") ||
    path.includes("[") ||
    path.endsWith("/") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe approved PLAN path: ${path}`);
  }
}

function exactArray(name: string, value: unknown, max: number, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error(`invalid ${name}`);
  }
  if ((!allowEmpty && value.length === 0) || value.length > max) {
    throw new Error(`${name} exceeds or misses its bounded size`);
  }
  return [...value] as string[];
}

function authorizationPayload(artifact: PlanAuthorizeArtifact): Omit<PlanAuthorizeArtifact, "digestAlgorithm" | "authorizationDigest"> {
  return {
    schemaVersion: 1,
    kind: "trusted-plan-authorize",
    requirement: { ...artifact.requirement },
    repository: artifact.repository,
    targetSha: artifact.targetSha,
    plan: {
      runId: artifact.plan.runId,
      runAttempt: artifact.plan.runAttempt,
      artifact: { ...artifact.plan.artifact },
      provenanceArtifact: { ...artifact.plan.provenanceArtifact },
    },
    approval: { ...artifact.approval },
    authorization: { ...artifact.authorization },
  };
}

export function verifyPlanAuthorizeArtifact(value: unknown): PlanAuthorizeArtifact {
  if (!record(value)) throw new Error("PLAN_AUTHORIZE artifact must be an object");
  if (value.schemaVersion !== 1 || value.kind !== "trusted-plan-authorize" || value.digestAlgorithm !== "sha256") {
    throw new Error("unsupported PLAN_AUTHORIZE artifact schema");
  }
  if (!record(value.authorization)) throw new Error("PLAN_AUTHORIZE authorization identity missing");
  positiveInteger("authorization.runId", value.authorization.runId);
  positiveInteger("authorization.runAttempt", value.authorization.runAttempt);
  assertDigest("authorizationDigest", value.authorizationDigest);

  const artifact = value as unknown as PlanAuthorizeArtifact;
  validateApprovedPlanIdentity(toApprovedPlanIdentity(artifact));
  const expected = createHash("sha256")
    .update(JSON.stringify(authorizationPayload(artifact)), "utf8")
    .digest("hex");
  if (artifact.authorizationDigest !== expected) {
    throw new Error("PLAN_AUTHORIZE artifact digest mismatch");
  }
  return artifact;
}

export function validatePlanAuthorizeSource(
  artifact: PlanAuthorizeArtifact,
  source: PlanAuthorizeSourceRun,
): void {
  verifyPlanAuthorizeArtifact(artifact);
  positiveInteger("source run id", source.id);
  positiveInteger("source run attempt", source.runAttempt);
  if (source.repository !== artifact.repository) throw new Error("PLAN_AUTHORIZE source repository mismatch");
  if (source.workflowPath !== PLAN_AUTHORIZE_WORKFLOW_PATH) throw new Error("unexpected PLAN_AUTHORIZE source workflow");
  if (source.event !== "issue_comment" || source.conclusion !== "success") {
    throw new Error("PLAN_AUTHORIZE source run is not a successful issue_comment run");
  }
  if (source.headBranch !== source.defaultBranch) throw new Error("PLAN_AUTHORIZE source is not on the default branch");
  if (!GIT_SHA.test(source.headSha) || !GIT_SHA.test(source.currentDefaultSha)) throw new Error("invalid source SHA");
  if (source.id !== artifact.authorization.runId || source.runAttempt !== artifact.authorization.runAttempt) {
    throw new Error("PLAN_AUTHORIZE source run identity mismatch");
  }
  if (source.headSha !== artifact.targetSha) throw new Error("PLAN_AUTHORIZE source SHA mismatch");
  if (source.currentDefaultSha !== artifact.targetSha) {
    throw new Error("default branch moved after PLAN approval; re-plan required");
  }
}

export function validatePlanAuthorizeSourceForRebind(
  artifact: PlanAuthorizeArtifact,
  source: PlanAuthorizeSourceRun,
  reboundTargetSha: string,
): void {
  verifyPlanAuthorizeArtifact(artifact);
  positiveInteger("source run id", source.id);
  positiveInteger("source run attempt", source.runAttempt);
  if (!GIT_SHA.test(reboundTargetSha) || reboundTargetSha === artifact.targetSha) {
    throw new Error("invalid PLAN rebind target SHA");
  }
  if (source.repository !== artifact.repository) throw new Error("PLAN_AUTHORIZE source repository mismatch");
  if (source.workflowPath !== PLAN_AUTHORIZE_WORKFLOW_PATH) throw new Error("unexpected PLAN_AUTHORIZE source workflow");
  if (source.event !== "issue_comment" || source.conclusion !== "success") {
    throw new Error("PLAN_AUTHORIZE source run is not a successful issue_comment run");
  }
  if (source.headBranch !== source.defaultBranch) throw new Error("PLAN_AUTHORIZE source is not on the default branch");
  if (!GIT_SHA.test(source.headSha) || !GIT_SHA.test(source.currentDefaultSha)) throw new Error("invalid source SHA");
  if (source.id !== artifact.authorization.runId || source.runAttempt !== artifact.authorization.runAttempt) {
    throw new Error("PLAN_AUTHORIZE source run identity mismatch");
  }
  if (source.headSha !== artifact.targetSha) throw new Error("PLAN_AUTHORIZE source SHA mismatch");
  if (source.currentDefaultSha !== reboundTargetSha) {
    throw new Error("PLAN rebind target is not exact current default SHA");
  }
}

export function validateApprovedPlanDocument(value: unknown): ApprovedPlanDocument {
  if (!record(value)) throw new Error("approved PLAN must be an object");
  if (!Array.isArray(value.questions) || !value.questions.every((item) => typeof item === "string")) {
    throw new Error("approved PLAN questions are invalid");
  }
  if (value.questions.length !== 0) throw new Error("approved PLAN still has blocking questions");
  const approach = exactArray("approach", value.approach, 8, false);
  if (!record(value.implementationScope)) throw new Error("approved PLAN implementationScope missing");

  const scope = value.implementationScope;
  const expectedKeys = ["allowedPaths", "forbiddenChanges", "ready", "requiredChanges", "validationCommands"];
  if (JSON.stringify(Object.keys(scope).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("approved PLAN implementationScope shape is invalid");
  }
  if (scope.ready !== true) throw new Error("approved PLAN implementationScope is not ready");

  const allowedPaths = exactArray("allowedPaths", scope.allowedPaths, PLAN_IMPLEMENT_MAX_FILES, false);
  const requiredChanges = exactArray("requiredChanges", scope.requiredChanges, 8, false);
  const forbiddenChanges = exactArray("forbiddenChanges", scope.forbiddenChanges, 8, true);
  const validationCommands = exactArray("validationCommands", scope.validationCommands, 2, false);
  if (new Set(allowedPaths).size !== allowedPaths.length) throw new Error("approved PLAN allowedPaths must be unique");
  for (const path of allowedPaths) assertSafePath(path);
  for (const command of validationCommands) {
    if (!TRUSTED_VALIDATION_COMMANDS.has(command)) throw new Error(`untrusted approved validation command: ${command}`);
  }

  return {
    questions: [],
    approach,
    implementationScope: {
      ready: true,
      allowedPaths,
      requiredChanges,
      forbiddenChanges,
      validationCommands,
    },
  };
}

function extractCanonicalPlanDocument(
  value: unknown,
  authorization: PlanAuthorizeArtifact,
): ApprovedPlanDocument {
  if (!record(value)) throw new Error("approved PLAN artifact must be an object");
  const expectedKeys = ["context", "kind", "plan", "repository", "requirement", "sha"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("approved PLAN artifact wrapper shape is invalid");
  }
  if (value.kind !== "untrusted-plan") throw new Error("approved PLAN artifact kind is invalid");
  if (value.repository !== authorization.repository) throw new Error("approved PLAN artifact repository mismatch");
  if (value.sha !== authorization.targetSha) throw new Error("approved PLAN artifact SHA mismatch");
  if (typeof value.requirement !== "string" || !value.requirement.trim()) {
    throw new Error("approved PLAN artifact requirement is invalid");
  }
  if (!record(value.context)) throw new Error("approved PLAN artifact context is invalid");
  const contextKeys = ["digest", "digestAlgorithm", "evidence", "totalBytes"];
  if (JSON.stringify(Object.keys(value.context).sort()) !== JSON.stringify(contextKeys)) {
    throw new Error("approved PLAN artifact context shape is invalid");
  }
  if (value.context.digestAlgorithm !== "sha256") throw new Error("approved PLAN artifact context digest algorithm is invalid");
  assertDigest("approved PLAN artifact context digest", value.context.digest);
  if (!Array.isArray(value.context.evidence)) throw new Error("approved PLAN artifact context evidence is invalid");
  if (typeof value.context.totalBytes !== "number" || !Number.isSafeInteger(value.context.totalBytes) || value.context.totalBytes < 0) {
    throw new Error("approved PLAN artifact context totalBytes is invalid");
  }
  if (!record(value.plan)) throw new Error("approved PLAN artifact plan is invalid");
  return validateApprovedPlanDocument(value.plan);
}

function approvedPlanContextPaths(value: unknown): string[] {
  if (!record(value) || !record(value.context) || !Array.isArray(value.context.evidence)) {
    throw new Error("approved PLAN artifact context evidence is invalid");
  }
  const paths = value.context.evidence.map((item) => {
    if (!record(item) || typeof item.path !== "string") {
      throw new Error("approved PLAN context evidence path is invalid");
    }
    assertSafePath(item.path);
    return item.path;
  });
  if (new Set(paths).size !== paths.length) {
    throw new Error("approved PLAN context evidence paths must be unique");
  }
  return paths;
}

function frameworkOnlyRebindPath(path: string): boolean {
  return (
    path.startsWith("src/self-improvement/") ||
    path.startsWith(".github/workflows/") ||
    path.startsWith("test/")
  );
}

function planRebindPayload(value: PlanRebindProvenance): PlanRebindProvenancePayload {
  return {
    schemaVersion: 1,
    kind: "trusted-plan-rebind",
    repository: value.repository,
    issueNumber: value.issueNumber,
    sourceAuthorizationDigest: value.sourceAuthorizationDigest,
    sourceTargetSha: value.sourceTargetSha,
    reboundTargetSha: value.reboundTargetSha,
    changedPaths: [...value.changedPaths],
  };
}

export function createPlanRebindProvenance(
  authorization: PlanAuthorizeArtifact,
  planValue: unknown,
  reboundTargetSha: string,
  changedPaths: readonly string[],
): PlanRebindProvenance {
  const trustedAuthorization = verifyPlanAuthorizeArtifact(authorization);
  const plan = extractCanonicalPlanDocument(planValue, trustedAuthorization);
  if (!GIT_SHA.test(reboundTargetSha)) throw new Error("rebound target SHA is invalid");
  if (reboundTargetSha === trustedAuthorization.targetSha) {
    throw new Error("rebind requires a moved target SHA");
  }
  if (changedPaths.length < 1 || changedPaths.length > PLAN_REBIND_MAX_DRIFT_FILES) {
    throw new Error("rebind drift exceeds bounded file count");
  }
  const normalized = [...changedPaths].sort((a, b) => a.localeCompare(b));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("rebind drift paths must be unique");
  }
  for (const path of normalized) {
    assertSafePath(path);
    if (!frameworkOnlyRebindPath(path)) {
      throw new Error(`rebind drift is not framework-only: ${path}`);
    }
  }
  const protectedPaths = new Set([
    ...approvedPlanContextPaths(planValue),
    ...plan.implementationScope.allowedPaths,
  ]);
  const overlap = normalized.filter((path) => protectedPaths.has(path));
  if (overlap.length > 0) {
    throw new Error(`rebind drift overlaps approved PLAN context/scope: ${overlap.join(",")}`);
  }
  const payload: PlanRebindProvenancePayload = {
    schemaVersion: 1,
    kind: "trusted-plan-rebind",
    repository: trustedAuthorization.repository,
    issueNumber: trustedAuthorization.requirement.issueNumber,
    sourceAuthorizationDigest: trustedAuthorization.authorizationDigest,
    sourceTargetSha: trustedAuthorization.targetSha,
    reboundTargetSha,
    changedPaths: normalized,
  };
  const rebindDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return { ...payload, digestAlgorithm: "sha256", rebindDigest };
}

export function verifyPlanRebindProvenance(
  value: unknown,
  authorization: PlanAuthorizeArtifact,
): PlanRebindProvenance {
  const trustedAuthorization = verifyPlanAuthorizeArtifact(authorization);
  if (!record(value)) throw new Error("PLAN rebind provenance must be an object");
  const expectedKeys = [
    "changedPaths", "digestAlgorithm", "issueNumber", "kind", "rebindDigest",
    "reboundTargetSha", "repository", "schemaVersion", "sourceAuthorizationDigest", "sourceTargetSha",
  ].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("PLAN rebind provenance shape is invalid");
  }
  if (value.schemaVersion !== 1 || value.kind !== "trusted-plan-rebind" || value.digestAlgorithm !== "sha256") {
    throw new Error("unsupported PLAN rebind provenance schema");
  }
  if (
    value.repository !== trustedAuthorization.repository ||
    value.issueNumber !== trustedAuthorization.requirement.issueNumber ||
    value.sourceAuthorizationDigest !== trustedAuthorization.authorizationDigest ||
    value.sourceTargetSha !== trustedAuthorization.targetSha
  ) {
    throw new Error("PLAN rebind source authorization mismatch");
  }
  if (typeof value.reboundTargetSha !== "string" || !GIT_SHA.test(value.reboundTargetSha) || value.reboundTargetSha === value.sourceTargetSha) {
    throw new Error("PLAN rebind target SHA is invalid");
  }
  if (!Array.isArray(value.changedPaths) || value.changedPaths.length < 1 || value.changedPaths.length > PLAN_REBIND_MAX_DRIFT_FILES) {
    throw new Error("PLAN rebind changedPaths are invalid");
  }
  if (!value.changedPaths.every((path) => typeof path === "string")) {
    throw new Error("PLAN rebind changedPaths are invalid");
  }
  const changedPaths = [...value.changedPaths] as string[];
  if (JSON.stringify(changedPaths) !== JSON.stringify([...changedPaths].sort((a, b) => a.localeCompare(b))) ||
      new Set(changedPaths).size !== changedPaths.length) {
    throw new Error("PLAN rebind changedPaths must be sorted and unique");
  }
  for (const path of changedPaths) {
    assertSafePath(path);
    if (!frameworkOnlyRebindPath(path)) throw new Error(`PLAN rebind drift is not framework-only: ${path}`);
  }
  assertDigest("PLAN rebind digest", value.rebindDigest);
  const provenance = value as unknown as PlanRebindProvenance;
  const expected = createHash("sha256").update(JSON.stringify(planRebindPayload(provenance)), "utf8").digest("hex");
  if (expected !== provenance.rebindDigest) throw new Error("PLAN rebind provenance digest mismatch");
  return provenance;
}

export function createPlanImplementContract(
  authorization: PlanAuthorizeArtifact,
  planValue: unknown,
  rebind?: PlanRebindProvenance,
): ImplementContract {
  const trustedAuthorization = verifyPlanAuthorizeArtifact(authorization);
  const plan = extractCanonicalPlanDocument(planValue, trustedAuthorization);
  const trustedRebind = rebind ? verifyPlanRebindProvenance(rebind, trustedAuthorization) : undefined;
  const scope = plan.implementationScope;
  const allowedPaths = [...scope.allowedPaths];
  const requiredChanges = [...scope.requiredChanges];

  if (allowedPaths.includes("package.json")) {
    if (!allowedPaths.includes("package-lock.json")) {
      if (allowedPaths.length >= PLAN_IMPLEMENT_MAX_FILES) {
        throw new Error("approved PLAN package.json change requires package-lock.json within bounded scope");
      }
      allowedPaths.push("package-lock.json");
    }
    requiredChanges.push("package.json 변경 시 package-lock.json을 같은 candidate에서 동기화한다.");
  }

  const identity = {
    ...toApprovedPlanIdentity(trustedAuthorization),
    targetSha: trustedRebind?.reboundTargetSha ?? trustedAuthorization.targetSha,
  };
  return createImplementContract(identity, {
    allowedPaths,
    requiredChanges: [
      ...requiredChanges,
      ...plan.approach.map((item) => `승인된 PLAN approach: ${item}`),
    ],
    forbiddenChanges: scope.forbiddenChanges,
    validationCommands: scope.validationCommands,
    maxFilesChanged: allowedPaths.length,
    maxContextBytes: PLAN_IMPLEMENT_MAX_CONTEXT_BYTES,
    maxPatchBytes: PLAN_IMPLEMENT_MAX_PATCH_BYTES,
  });
}

export function planImplementHandoffArtifactName(authorization: PlanAuthorizeArtifact): string {
  const trusted = verifyPlanAuthorizeArtifact(authorization);
  return `plan-implement-handoff-issue-${trusted.requirement.issueNumber}-plan-${trusted.plan.runId}-attempt-${trusted.plan.runAttempt}-approval-${trusted.approval.commentId}`;
}

export function createPlanImplementHandoffManifest(input: {
  readonly authorization: PlanAuthorizeArtifact;
  readonly sourceArtifact: PlanAuthorizeArtifactMetadata;
  readonly contract: ImplementContract;
  readonly contextDigest: string;
  readonly rebind?: PlanRebindProvenance;
}): PlanImplementHandoffManifest {
  const authorization = verifyPlanAuthorizeArtifact(input.authorization);
  const rebind = input.rebind ? verifyPlanRebindProvenance(input.rebind, authorization) : undefined;
  assertDigest("source PLAN_AUTHORIZE artifact digest", input.sourceArtifact.digest);
  positiveInteger("source PLAN_AUTHORIZE artifact id", input.sourceArtifact.id);
  if (!input.sourceArtifact.name.trim()) throw new Error("source PLAN_AUTHORIZE artifact name missing");
  assertDigest("contextDigest", input.contextDigest);
  const expectedBaseSha = rebind?.reboundTargetSha ?? authorization.targetSha;
  if (input.contract.repository !== authorization.repository || input.contract.baseSha !== expectedBaseSha) {
    throw new Error("IMPLEMENT contract is not bound to approved PLAN/rebind identity");
  }

  const payload: PlanImplementHandoffPayload = {
    schemaVersion: 1,
    kind: "trusted-plan-implement-handoff",
    repository: authorization.repository,
    baseSha: expectedBaseSha,
    issueNumber: authorization.requirement.issueNumber,
    sourcePlanAuthorize: {
      runId: authorization.authorization.runId,
      runAttempt: authorization.authorization.runAttempt,
      artifact: { ...input.sourceArtifact },
    },
    approvedPlan: {
      runId: authorization.plan.runId,
      runAttempt: authorization.plan.runAttempt,
      artifactName: authorization.plan.artifact.name,
    },
    approvalCommentId: authorization.approval.commentId,
    ...(rebind ? { rebindDigest: rebind.rebindDigest } : {}),
    contractDigest: input.contract.contractDigest,
    contextDigest: input.contextDigest,
  };
  const handoffDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return { ...payload, digestAlgorithm: "sha256", handoffDigest };
}
