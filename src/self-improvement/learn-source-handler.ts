import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { verifyAppRuntimeEvidence, type AppRuntimeEvidence } from "../app-evidence.js";
import {
  createLearnInputPack,
  type LearnEvidenceInput,
} from "./learn-input-pack.js";
import { createTrustedLearnSourceArtifacts, type TrustedLearnSourceFacts } from "./learn-source.js";

type JsonObject = Record<string, unknown>;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다`);
  return value;
}

function positiveIntegerEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name}은 양의 정수여야 합니다`);
  return value;
}

function parseJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function asObject(name: string, value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(object: JsonObject, key: string, name: string): string {
  const value = object[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requiredPositiveInteger(object: JsonObject, key: string, name: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function writeOutput(name: string, value: string | number): void {
  appendFileSync(requiredEnv("GITHUB_OUTPUT"), `${name}=${String(value)}\n`, "utf8");
}

const facts = parseJson(requiredEnv("LEARN_SOURCE_FACTS_JSON")) as TrustedLearnSourceFacts;
const orchestration = parseJson(requiredEnv("ORCHESTRATION_JSON"));
const outputDir = requiredEnv("LEARN_SOURCE_OUTPUT_DIR");
const result = createTrustedLearnSourceArtifacts(facts, orchestration);

const cycle = {
  recordDigest: result.completedCycle.recordDigest,
  requirementIssueNumber: result.completedCycle.requirement.issueNumber,
  humanMergePullRequestNumber: result.completedCycle.humanMerge.pullRequestNumber,
  reviewedHeadSha: result.completedCycle.source.review.reviewedHeadSha,
};

let evidenceInputs: LearnEvidenceInput[] = result.learnInputPack.evidence.map((item) => ({
  evidenceId: item.evidenceId,
  kind: item.kind,
  repository: item.repository,
  cycle: { ...item.cycle },
  source: { ...item.source },
  content: item.content,
}));

const appEvidencePath = process.env.APP_EVIDENCE_JSON;
if (appEvidencePath) {
  const appEvidence = parseJson(appEvidencePath) as AppRuntimeEvidence;
  verifyAppRuntimeEvidence(appEvidence, requiredEnv("APP_EVIDENCE_SOURCE_SHA"));

  evidenceInputs.push({
    evidenceId: "app-runtime-01",
    kind: "app-runtime",
    repository: result.completedCycle.repository,
    cycle,
    source: {
      kind: "workflow-run",
      runId: positiveIntegerEnv("APP_EVIDENCE_SOURCE_RUN_ID"),
      runAttempt: positiveIntegerEnv("APP_EVIDENCE_SOURCE_RUN_ATTEMPT"),
    },
    content: JSON.stringify(appEvidence),
  });
}

const businessEvidencePath = process.env.BUSINESS_EVIDENCE_JSON;
if (businessEvidencePath && existsSync(businessEvidencePath)) {
  const business = asObject("Business Evidence", parseJson(businessEvidencePath));
  if (business.schemaVersion !== 1 || business.kind !== "repository-business-feedback") {
    throw new Error("unsupported Business Evidence schema");
  }
  const repository = requiredString(business, "repository", "business.repository");
  if (repository !== result.completedCycle.repository) {
    throw new Error("Business Evidence repository mismatch");
  }
  const issueNumber = requiredPositiveInteger(business, "issueNumber", "business.issueNumber");
  const title = requiredString(business, "title", "business.title");
  const body = requiredString(business, "body", "business.body");
  const titleBodyDigest = requiredString(
    business,
    "titleBodyDigest",
    "business.titleBodyDigest",
  );
  const expectedDigest = sha256(JSON.stringify([title, body]));
  if (titleBodyDigest !== expectedDigest) {
    throw new Error("Business Evidence title/body digest mismatch");
  }

  evidenceInputs.push({
    evidenceId: "business-feedback-01",
    kind: "business-feedback",
    repository,
    cycle,
    source: {
      kind: "business-issue",
      issueNumber,
      titleBodyDigest,
    },
    content: JSON.stringify({
      issueNumber,
      title,
      body,
      titleBodyDigest,
    }),
  });
}

const learnInputPack = createLearnInputPack(result.completedCycle, evidenceInputs);

const completedDir = `${outputDir}/completed-cycle`;
const inputDir = `${outputDir}/learn-input`;
mkdirSync(completedDir, { recursive: true });
mkdirSync(inputDir, { recursive: true });

writeFileSync(
  `${completedDir}/completed-cycle.json`,
  `${JSON.stringify(result.completedCycle, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  `${inputDir}/learn-input-pack.json`,
  `${JSON.stringify(learnInputPack, null, 2)}\n`,
  "utf8",
);

writeOutput("issue_number", result.completedCycle.requirement.issueNumber);
writeOutput("human_merge_pr", result.completedCycle.humanMerge.pullRequestNumber);
writeOutput("completed_cycle_artifact_name", result.completedCycleArtifactName);
writeOutput("learn_input_artifact_name", result.learnInputArtifactName);
writeOutput("record_digest", result.completedCycle.recordDigest);
writeOutput("pack_digest", learnInputPack.packDigest);
