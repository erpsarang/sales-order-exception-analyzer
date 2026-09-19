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
  for (const entry of readdirSync(root, { withFileTypes: true })) {
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
const sessionsDir = join(codexHome, "sessions");
const files = rolloutFiles(sessionsDir);
if (files.length !== 1) {
  throw new Error(`expected exactly one fresh Codex rollout JSONL, found ${files.length}`);
}

const rollout = files[0]!;
const size = statSync(rollout).size;
if (size <= 0 || size > MAX_ROLLOUT_BYTES) {
  throw new Error(`Codex rollout size is out of bounds: ${size}`);
}

const usage = parseCodexRolloutUsage(readFileSync(rollout, "utf8"));
const runId = positiveIntegerEnv("AI_USAGE_RUN_ID");
const runAttempt = positiveIntegerEnv("AI_USAGE_RUN_ATTEMPT");
const stage = requiredEnv("AI_USAGE_STAGE");
const jobName = requiredEnv("AI_USAGE_JOB_NAME");
const output = requiredEnv("AI_USAGE_JSON");

const record = createAiUsageRecord({
  stage,
  runId,
  runAttempt,
  jobName,
  usage,
});

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, "utf8");

writeOutput("input_tokens", usage.inputTokens);
writeOutput("cached_input_tokens", usage.cachedInputTokens);
writeOutput("cache_write_input_tokens", usage.cacheWriteInputTokens);
writeOutput("output_tokens", usage.outputTokens);
writeOutput("reasoning_output_tokens", usage.reasoningOutputTokens);
writeOutput("total_tokens", usage.totalTokens);
writeOutput("artifact_name", `ai-usage-${stage}-${runId}-attempt-${runAttempt}`);
