import assert from "node:assert/strict";
import test from "node:test";
import {
  createAiUsageRecord,
  parseCodexRolloutUsage,
  parseCodexTurnUsageFromLog,
} from "../src/self-improvement/ai-usage.js";

const completed = JSON.stringify({
  type: "turn.completed",
  usage: {
    input_tokens: 24763,
    cached_input_tokens: 24448,
    cache_write_input_tokens: 0,
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
    cacheWriteInputTokens: 0,
    outputTokens: 122,
    reasoningOutputTokens: 0,
    totalTokens: 24885,
  });
});

test("Codex rollout의 최신 persisted TokenCount에서 exact usage를 추출한다", () => {
  const first = {
    timestamp: "2026-09-19T16:36:20Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 12000,
          cached_input_tokens: 0,
          cache_write_input_tokens: 11990,
          output_tokens: 500,
          reasoning_output_tokens: 100,
          total_tokens: 12500,
        },
        last_token_usage: {
          input_tokens: 12000,
          cached_input_tokens: 0,
          cache_write_input_tokens: 11990,
          output_tokens: 500,
          reasoning_output_tokens: 100,
          total_tokens: 12500,
        },
        model_context_window: 128000,
      },
      rate_limits: null,
    },
  };
  const latest = {
    timestamp: "2026-09-19T16:36:34Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 12909,
          cached_input_tokens: 0,
          cache_write_input_tokens: 12906,
          output_tokens: 989,
          reasoning_output_tokens: 198,
          total_tokens: 13898,
        },
        last_token_usage: {
          input_tokens: 909,
          cached_input_tokens: 0,
          cache_write_input_tokens: 916,
          output_tokens: 489,
          reasoning_output_tokens: 98,
          total_tokens: 1398,
        },
        model_context_window: 128000,
      },
      rate_limits: null,
    },
  };

  const usage = parseCodexRolloutUsage(
    [JSON.stringify(first), JSON.stringify(latest)].join("\n"),
  );
  assert.deepEqual(usage, {
    inputTokens: 12909,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 12906,
    outputTokens: 989,
    reasoningOutputTokens: 198,
    totalTokens: 13898,
  });
});

test("Codex rollout은 TokenCount가 없으면 token_usage_record를 fallback으로 사용한다", () => {
  const rollout = JSON.stringify({
    timestamp: "2026-09-19T16:36:34Z",
    type: "token_usage_record",
    payload: {
      thread_id: "00000000-0000-0000-0000-000000000001",
      turn_id: "turn-1",
      session_id: "00000000-0000-0000-0000-000000000002",
      root_turn_id: "turn-1",
      response_id: "resp-1",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 10,
        cache_write_input_tokens: 20,
        output_tokens: 30,
        reasoning_output_tokens: 5,
        total_tokens: 130,
      },
      turn_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 10,
        cache_write_input_tokens: 20,
        output_tokens: 30,
        reasoning_output_tokens: 5,
        total_tokens: 130,
      },
      thread_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 10,
        cache_write_input_tokens: 20,
        output_tokens: 30,
        reasoning_output_tokens: 5,
        total_tokens: 130,
      },
    },
  });

  assert.equal(parseCodexRolloutUsage(rollout).totalTokens, 130);
});

test("rollout usage가 없거나 JSONL이 깨지면 fail-closed한다", () => {
  assert.throws(
    () => parseCodexRolloutUsage(
      JSON.stringify({ timestamp: "x", type: "event_msg", payload: { type: "task_started" } }),
    ),
    /does not contain persisted token usage/,
  );
  assert.throws(() => parseCodexRolloutUsage("{not-json"), /line 1 is malformed/);
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

test("cached/cache-write/reasoning token 경계를 검증한다", () => {
  assert.throws(() => parseCodexTurnUsageFromLog(JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 11,
      cache_write_input_tokens: 0,
      output_tokens: 2,
      reasoning_output_tokens: 0,
    },
  })), /cached input/);

  assert.throws(() => parseCodexTurnUsageFromLog(JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 0,
      cache_write_input_tokens: 11,
      output_tokens: 2,
      reasoning_output_tokens: 0,
    },
  })), /cache-write input/);

  assert.throws(() => parseCodexTurnUsageFromLog(JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 5,
      cache_write_input_tokens: 0,
      output_tokens: 2,
      reasoning_output_tokens: 3,
    },
  })), /reasoning output/);
});

test("usage record는 exact run/attempt/job identity를 보존한다", () => {
  const usage = parseCodexTurnUsageFromLog(completed);
  const byId = createAiUsageRecord({
    stage: "semantic-review",
    runId: 100,
    runAttempt: 2,
    jobId: 300,
    usage,
  });
  assert.deepEqual(byId.source, { runId: 100, runAttempt: 2, jobId: 300 });

  const byName = createAiUsageRecord({
    stage: "learn",
    runId: 101,
    runAttempt: 1,
    jobName: "learner",
    usage,
  });
  assert.deepEqual(byName.source, { runId: 101, runAttempt: 1, jobName: "learner" });
  assert.equal(byName.usage.totalTokens, 24885);

  assert.throws(() => createAiUsageRecord({
    stage: "learn",
    runId: 101,
    runAttempt: 1,
    jobId: 1,
    jobName: "learner",
    usage,
  }), /exactly one/);
});
