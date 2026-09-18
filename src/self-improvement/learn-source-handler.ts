import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { verifyAppRuntimeEvidence, type AppRuntimeEvidence } from "../app-evidence.js";
import {
  createLearnInputPack,
  type LearnEvidenceInput,
} from "./learn-input-pack.js";
import { createTrustedLearnSourceArtifacts, type TrustedLearnSourceFacts } from "./learn-source.js";

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

function writeOutput(name: string, value: string | number): void {
  appendFileSync(requiredEnv("GITHUB_OUTPUT"), `${name}=${String(value)}\n`, "utf8");
}

const facts = parseJson(requiredEnv("LEARN_SOURCE_FACTS_JSON")) as TrustedLearnSourceFacts;
const orchestration = parseJson(requiredEnv("ORCHESTRATION_JSON"));
const outputDir = requiredEnv("LEARN_SOURCE_OUTPUT_DIR");
const result = createTrustedLearnSourceArtifacts(facts, orchestration);

let learnInputPack = result.learnInputPack;
const appEvidencePath = process.env.APP_EVIDENCE_JSON;
if (appEvidencePath) {
  const appEvidence = parseJson(appEvidencePath) as AppRuntimeEvidence;
  verifyAppRuntimeEvidence(appEvidence, requiredEnv("APP_EVIDENCE_SOURCE_SHA"));

  const cycle = {
    recordDigest: result.completedCycle.recordDigest,
    requirementIssueNumber: result.completedCycle.requirement.issueNumber,
    humanMergePullRequestNumber: result.completedCycle.humanMerge.pullRequestNumber,
    reviewedHeadSha: result.completedCycle.source.review.reviewedHeadSha,
  };
  const baseEvidence: LearnEvidenceInput[] = result.learnInputPack.evidence.map((item) => ({
    evidenceId: item.evidenceId,
    kind: item.kind,
    repository: item.repository,
    cycle: { ...item.cycle },
    source: { ...item.source },
    content: item.content,
  }));
  const appEvidenceInput: LearnEvidenceInput = {
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
  };
  learnInputPack = createLearnInputPack(
    result.completedCycle,
    [...baseEvidence, appEvidenceInput],
  );
}

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
