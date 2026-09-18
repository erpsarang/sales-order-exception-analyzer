import assert from "node:assert/strict";
import test from "node:test";
import { createCompletedCycleRecord } from "../src/self-improvement/completed-cycle.js";
import { createLearnInputPack, type LearnEvidenceInput } from "../src/self-improvement/learn-input-pack.js";
import { createLearnReport } from "../src/self-improvement/learn-report.js";

const sha = "a".repeat(40);
const digest = "b".repeat(64);

function record() {
  return createCompletedCycleRecord({
    repository: "erpsarang/sales-order-exception-analyzer",
    requirement: { issueNumber: 32, digest },
    mergedPullRequest: {
      number: 33,
      merged: true,
      headSha: sha,
      mergeCommitSha: "c".repeat(40),
      mergedAt: "2026-09-18T13:20:57Z",
    },
    source: {
      requirement: { issueNumber: 32, digest },
      review: { decision: "PASS", reviewedHeadSha: sha },
      trustedRail: { runId: 35344733517, runAttempt: 1, controlPlaneSha: "d".repeat(40) },
      orchestrationProvenance: {
        artifact: { name: "orchestration", id: 1, digest: "e".repeat(64) },
      },
      frameworkSourceSha: "f".repeat(40),
    },
  });
}

function cycle(r: ReturnType<typeof record>) {
  return {
    recordDigest: r.recordDigest,
    requirementIssueNumber: r.requirement.issueNumber,
    humanMergePullRequestNumber: r.humanMerge.pullRequestNumber,
    reviewedHeadSha: r.source.review.reviewedHeadSha,
  };
}

const identity = {
  sourceRun: { runId: 10, runAttempt: 1 },
  inputPackArtifact: { name: "learn-input", id: 2, digest: "1".repeat(64) },
  learner: { provider: "OpenAI", action: "codex-action", model: "default", reasoningEffort: "medium" },
};

function raw(packDigest: string, evidenceIds: string[]) {
  return {
    schemaVersion: 1,
    kind: "untrusted-learn-report",
    sourcePackDigest: packDigest,
    observations: [],
    lessons: [],
    improvementHypotheses: [{
      id: "hypothesis-1",
      statement: "실제 업무 불편과 App 동작을 함께 근거로 App을 개선한다.",
      evidenceIds,
      confidence: "medium",
    }],
    uncertainties: [],
  };
}

function evidence(r: ReturnType<typeof record>): LearnEvidenceInput[] {
  return [
    {
      evidenceId: "requirement-01",
      kind: "requirement-summary",
      repository: r.repository,
      cycle: cycle(r),
      source: { kind: "issue", issueNumber: 32 },
      content: "{}",
    },
    {
      evidenceId: "app-runtime-01",
      kind: "app-runtime",
      repository: r.repository,
      cycle: cycle(r),
      source: { kind: "workflow-run", runId: 20, runAttempt: 1 },
      content: "{\"kind\":\"sales-order-app-runtime-evidence\"}",
    },
    {
      evidenceId: "business-feedback-01",
      kind: "business-feedback",
      repository: r.repository,
      cycle: cycle(r),
      source: {
        kind: "business-issue",
        issueNumber: 8,
        titleBodyDigest: "2".repeat(64),
      },
      content: "{\"issueNumber\":8,\"title\":\"업무 요구\",\"body\":\"실제 불편\"}",
    },
  ];
}

test("App/Business Evidence가 모두 없으면 improvement hypothesis를 거부한다", () => {
  const r = record();
  const pack = createLearnInputPack(r, [evidence(r)[0]!]);

  assert.throws(() => createLearnReport(pack, raw(pack.packDigest, ["requirement-01"]), identity));
});

test("App Runtime Evidence만으로는 improvement hypothesis를 허용하지 않는다", () => {
  const r = record();
  const items = evidence(r);
  const pack = createLearnInputPack(r, [items[0]!, items[1]!]);

  assert.throws(() => createLearnReport(pack, raw(pack.packDigest, ["app-runtime-01"]), identity));
});

test("improvement hypothesis는 App Runtime과 Business Feedback을 모두 직접 인용해야 한다", () => {
  const r = record();
  const pack = createLearnInputPack(r, evidence(r));

  assert.throws(() =>
    createLearnReport(pack, raw(pack.packDigest, ["app-runtime-01"]), identity),
  );
  assert.throws(() =>
    createLearnReport(pack, raw(pack.packDigest, ["business-feedback-01"]), identity),
  );

  const report = createLearnReport(
    pack,
    raw(pack.packDigest, ["app-runtime-01", "business-feedback-01"]),
    identity,
  );
  assert.equal(report.improvementHypotheses.length, 1);
});
