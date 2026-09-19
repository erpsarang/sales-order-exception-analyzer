import assert from "node:assert/strict";
import test from "node:test";
import { createAiUsageUnavailableObservation } from "../src/self-improvement/ai-usage-observation.js";

test("usage unavailable observation은 0 token으로 위조하지 않고 reason을 보존한다", () => {
  const observation = createAiUsageUnavailableObservation({
    stage: "bounded-implement-attempt0",
    runId: 100,
    runAttempt: 2,
    jobName: "attempt0",
    reason: "NO_PERSISTED_USAGE",
  });

  assert.deepEqual(observation, {
    schemaVersion: 1,
    kind: "ai-token-usage-unavailable",
    stage: "bounded-implement-attempt0",
    provider: "openai-codex-action",
    source: {
      runId: 100,
      runAttempt: 2,
      jobName: "attempt0",
    },
    reason: "NO_PERSISTED_USAGE",
  });
  assert.equal("usage" in observation, false);
});

test("usage unavailable observation은 identity 입력을 fail-closed 검증한다", () => {
  assert.throws(
    () => createAiUsageUnavailableObservation({
      stage: "",
      runId: 100,
      runAttempt: 1,
      jobName: "attempt0",
      reason: "NO_ROLLOUT",
    }),
    /stage/,
  );
  assert.throws(
    () => createAiUsageUnavailableObservation({
      stage: "bounded-implement-attempt0",
      runId: 0,
      runAttempt: 1,
      jobName: "attempt0",
      reason: "NO_ROLLOUT",
    }),
    /runId/,
  );
});
