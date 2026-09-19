import assert from "node:assert/strict";
import test from "node:test";
import { createAiUsageRecord } from "../src/self-improvement/ai-usage.js";
import {
  parseAiUsageRecordJson,
  summarizeBoundedImplementRecordedUsage,
} from "../src/self-improvement/ai-usage-summary.js";

function usage(total: number) {
  return {
    inputTokens: total - 10,
    cachedInputTokens: 5,
    cacheWriteInputTokens: 4,
    outputTokens: 10,
    reasoningOutputTokens: 2,
    totalTokens: total,
  };
}

test("bounded IMPLEMENT recorded usage를 동일 run에서 정확히 합산한다", () => {
  const attempt0 = createAiUsageRecord({
    stage: "bounded-implement-attempt0",
    runId: 100,
    runAttempt: 2,
    jobName: "attempt0",
    usage: usage(100),
  });
  const repair1 = createAiUsageRecord({
    stage: "bounded-implement-repair1",
    runId: 100,
    runAttempt: 2,
    jobName: "repair1",
    usage: usage(70),
  });

  const summary = summarizeBoundedImplementRecordedUsage({
    runId: 100,
    runAttempt: 2,
    records: [repair1, attempt0],
  });

  assert.equal(summary.kind, "ai-token-usage-summary");
  assert.equal(summary.scope, "bounded-implement-recorded");
  assert.deepEqual(summary.recordedStages, [
    "bounded-implement-attempt0",
    "bounded-implement-repair1",
  ]);
  assert.equal(summary.recordedCallCount, 2);
  assert.deepEqual(summary.usage, {
    inputTokens: 150,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 8,
    outputTokens: 20,
    reasoningOutputTokens: 4,
    totalTokens: 170,
  });
});

test("recorded usage가 없으면 0-call summary를 만든다", () => {
  const summary = summarizeBoundedImplementRecordedUsage({
    runId: 200,
    runAttempt: 1,
    records: [],
  });
  assert.equal(summary.recordedCallCount, 0);
  assert.equal(summary.usage.totalTokens, 0);
  assert.deepEqual(summary.recordedStages, []);
});

test("다른 run, 중복 stage, 허용되지 않은 stage는 fail-closed한다", () => {
  const base = createAiUsageRecord({
    stage: "bounded-implement-attempt0",
    runId: 300,
    runAttempt: 1,
    jobName: "attempt0",
    usage: usage(50),
  });

  assert.throws(
    () => summarizeBoundedImplementRecordedUsage({
      runId: 301,
      runAttempt: 1,
      records: [base],
    }),
    /run identity mismatch/,
  );
  assert.throws(
    () => summarizeBoundedImplementRecordedUsage({
      runId: 300,
      runAttempt: 1,
      records: [base, base],
    }),
    /duplicate/,
  );

  const unexpected = createAiUsageRecord({
    stage: "plan",
    runId: 300,
    runAttempt: 1,
    jobName: "plan",
    usage: usage(50),
  });
  assert.throws(
    () => summarizeBoundedImplementRecordedUsage({
      runId: 300,
      runAttempt: 1,
      records: [unexpected],
    }),
    /unexpected/,
  );
});

test("usage record JSON parser는 schema와 token 경계를 검증한다", () => {
  const record = createAiUsageRecord({
    stage: "bounded-implement-repair2",
    runId: 400,
    runAttempt: 3,
    jobName: "repair2",
    usage: usage(80),
  });
  assert.deepEqual(parseAiUsageRecordJson(JSON.stringify(record)), record);

  const malformed = JSON.parse(JSON.stringify(record));
  malformed.usage.cachedInputTokens = malformed.usage.inputTokens + 1;
  assert.throws(
    () => parseAiUsageRecordJson(JSON.stringify(malformed)),
    /cached input/,
  );
});
