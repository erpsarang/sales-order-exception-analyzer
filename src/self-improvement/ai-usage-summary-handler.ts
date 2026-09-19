import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  parseAiUsageRecordJson,
  summarizeBoundedImplementRecordedUsage,
} from "./ai-usage-summary.js";

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

const inputDirectory = requiredEnv("AI_USAGE_SUMMARY_DIRECTORY");
const output = requiredEnv("AI_USAGE_SUMMARY_JSON");
const runId = positiveIntegerEnv("AI_USAGE_RUN_ID");
const runAttempt = positiveIntegerEnv("AI_USAGE_RUN_ATTEMPT");

const records = readdirSync(inputDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  .sort((left, right) => left.name.localeCompare(right.name))
  .map((entry) =>
    parseAiUsageRecordJson(readFileSync(join(inputDirectory, entry.name), "utf8")),
  );

const summary = summarizeBoundedImplementRecordedUsage({
  runId,
  runAttempt,
  records,
});

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

writeOutput("recorded_call_count", summary.recordedCallCount);
writeOutput("recorded_total_tokens", summary.usage.totalTokens);
writeOutput(
  "artifact_name",
  `ai-usage-summary-bounded-implement-recorded-${runId}-attempt-${runAttempt}`,
);
