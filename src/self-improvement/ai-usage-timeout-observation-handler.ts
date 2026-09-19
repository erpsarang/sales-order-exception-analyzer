import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createAiUsageRecord, parseCodexRolloutUsage } from "./ai-usage.js";
import { createAiUsageUnavailableObservation } from "./ai-usage-observation.js";

const MAX_ROLLOUT_BYTES = 16 * 1024 * 1024;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다`);
  return value;
}

function positiveIntegerEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name}은 양의 정수여야 합니다`);
  }
  return value;
}

function writeOutput(name: string, value: string | number): void {
  appendFileSync(requiredEnv("GITHUB_OUTPUT"), `${name}=${String(value)}\n`, "utf8");
}

function rolloutFiles(root: string): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...rolloutFiles(path));
    } else if (
      entry.isFile() &&
      basename(path).startsWith("rollout-") &&
      path.endsWith(".jsonl")
    ) {
      results.push(path);
    }
  }
  return results.sort();
}

const codexHome = requiredEnv("CODEX_HOME_PATH");
const stage = requiredEnv("AI_USAGE_STAGE");
const runId = positiveIntegerEnv("AI_USAGE_RUN_ID");
const runAttempt = positiveIntegerEnv("AI_USAGE_RUN_ATTEMPT");
const jobName = requiredEnv("AI_USAGE_JOB_NAME");
const usageOutput = requiredEnv("AI_USAGE_JSON");
const unavailableOutput = requiredEnv("AI_USAGE_UNAVAILABLE_JSON");

const files = rolloutFiles(join(codexHome, "sessions"));
if (files.length > 1) {
  throw new Error(`expected at most one fresh Codex rollout JSONL, found ${files.length}`);
}

if (files.length === 0) {
  const observation = createAiUsageUnavailableObservation({
    stage,
    runId,
    runAttempt,
    jobName,
    reason: "NO_ROLLOUT",
  });
  mkdirSync(dirname(unavailableOutput), { recursive: true });
  writeFileSync(unavailableOutput, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
  writeOutput("status", "unavailable");
  writeOutput(
    "artifact_name",
    `ai-usage-observation-${stage}-timeout-${runId}-attempt-${runAttempt}`,
  );
  process.exit(0);
}

const rollout = files[0]!;
const size = statSync(rollout).size;
if (size <= 0 || size > MAX_ROLLOUT_BYTES) {
  throw new Error(`Codex rollout size is out of bounds: ${size}`);
}

let usage;
try {
  usage = parseCodexRolloutUsage(readFileSync(rollout, "utf8"));
} catch (error) {
  if (
    error instanceof Error &&
    error.message === "Codex rollout does not contain persisted token usage"
  ) {
    const observation = createAiUsageUnavailableObservation({
      stage,
      runId,
      runAttempt,
      jobName,
      reason: "NO_PERSISTED_USAGE",
    });
    mkdirSync(dirname(unavailableOutput), { recursive: true });
    writeFileSync(unavailableOutput, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
    writeOutput("status", "unavailable");
    writeOutput(
      "artifact_name",
      `ai-usage-observation-${stage}-timeout-${runId}-attempt-${runAttempt}`,
    );
    process.exit(0);
  }
  throw error;
}

const record = createAiUsageRecord({
  stage,
  runId,
  runAttempt,
  jobName,
  usage,
});
mkdirSync(dirname(usageOutput), { recursive: true });
writeFileSync(usageOutput, `${JSON.stringify(record, null, 2)}\n`, "utf8");
writeOutput("status", "recorded");
writeOutput("total_tokens", usage.totalTokens);
writeOutput("artifact_name", `ai-usage-${stage}-${runId}-attempt-${runAttempt}`);
