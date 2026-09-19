import assert from "node:assert/strict";
import test from "node:test";
import { createAiUsageRecord, parseCodexTurnUsageFromLog } from "../src/self-improvement/ai-usage.js";

const completed = JSON.stringify({
  type: "turn.completed",
  usage: {
    input_tokens: 24763,
    cached_input_tokens: 24448,
    output_tokens: 122,
    reasoning_output_tokens: 0,
  },
});

test("GitHub timestamp prefix가 있는 Codex JSONL에서 exact usage를 추출한다", () => {
  const log = [
    '2026-09-19T00:00:00Z {"type":"thread.started","thread_id":"t1"}',
    `2026-09-19T00:00:01Z ${completed}`,
  ].join("\n");

  const usage = parseCodexTurnUsageFromLog(log);
  assert.deepEqual(usage, {
    inputTokens: 24763,
    cachedInputTokens: 24448,
    outputTokens: 122,
    reasoningOutputTokens: 0,
    totalTokens: 24885,
  });
});

test("turn.completed usage가 없거나 중복이면 fail-closed한다", () => {
  assert.throws(
    () => parseCodexTurnUsageFromLog('2026-09-19T00:00:00Z {"type":"turn.started"}'),
    /exactly one/,
  );
  assert.throws(
    () => parseCodexTurnUsageFromLog(`${completed}\n${completed}\n`),
    /found 2/,
  );
});

test("cached/reasoning token은 각각 input/output을 넘을 수 없다", () => {
  assert.throws(() => parseCodexTurnUsageFromLog(JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 11,
      output_tokens: 2,
      reasoning_output_tokens: 0,
    },
  })), /cached input/);

  assert.throws(() => parseCodexTurnUsageFromLog(JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 5,
      output_tokens: 2,
      reasoning_output_tokens: 3,
    },
  })), /reasoning output/);
});

test("usage record는 exact run/attempt/job identity를 보존한다", () => {
  const usage = parseCodexTurnUsageFromLog(completed);
  const record = createAiUsageRecord({
    stage: "semantic-review",
    runId: 100,
    runAttempt: 2,
    jobId: 300,
    usage,
  });

  assert.equal(record.kind, "ai-token-usage");
  assert.equal(record.stage, "semantic-review");
  assert.deepEqual(record.source, { runId: 100, runAttempt: 2, jobId: 300 });
  assert.equal(record.usage.totalTokens, 24885);
});
