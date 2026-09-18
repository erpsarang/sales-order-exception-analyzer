import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bootstrap = await readFile(".github/workflows/app-self-improvement.yml", "utf8");
const orchestrator = await readFile(".github/workflows/orchestrator.yml", "utf8");
const learnSource = await readFile(".github/workflows/learn-source.yml", "utf8");
const learn = await readFile(".github/workflows/learn.yml", "utf8");
const candidate = await readFile(".github/workflows/improvement-candidate.yml", "utf8");
const candidateSource = await readFile("src/self-improvement/improvement-candidate.ts", "utf8");

test("Human Merge가 끝난 MERGE_READY PR만 App Self-Improvement bootstrap 대상이다", () => {
  assert.match(bootstrap, /pull_request:\n    types: \[closed\]/);
  assert.match(bootstrap, /github\.event\.pull_request\.merged == true/);
  assert.match(bootstrap, /ai-dev-framework:MERGE_READY/);
  assert.match(bootstrap, /ai-dev-framework:TRUSTED_RAIL/);
  assert.match(bootstrap, /merged Human Merge PR exact identity mismatch/);
  assert.match(bootstrap, /trustedRun\.path !== '\.github\/workflows\/trusted-rail\.yml'/);
});

test("Orchestrator는 Human Merge PR에 exact Trusted Rail provenance marker를 기록한다", () => {
  assert.match(orchestrator, /TRUSTED_RAIL_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(orchestrator, /TRUSTED_RAIL_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(orchestrator, /ai-dev-framework:TRUSTED_RAIL run-id=/);
  assert.match(orchestrator, /orchestration-provenance-issue-/);
});

test("Business Feedback은 열린 [사용자 피드백] Issue가 정확히 하나일 때만 자동 선택한다", () => {
  assert.match(bootstrap, /state: 'open'/);
  assert.match(bootstrap, /issue\.title\.startsWith\('\[사용자 피드백\]'\)/);
  assert.match(bootstrap, /businessFeedback\.length === 0/);
  assert.match(bootstrap, /businessFeedback\.length !== 1/);
  assert.match(bootstrap, /열린 \[사용자 피드백\] Issue가 없어 이번 cycle은 no-op/);
});

test("Human Merge bootstrap은 exact provenance를 Trusted LEARN Source에 자동 전달한다", () => {
  assert.match(bootstrap, /workflow_id: 'learn-source\.yml'/);
  assert.match(bootstrap, /requirement_issue_number: process\.env\.REQUIREMENT_ISSUE_NUMBER/);
  assert.match(bootstrap, /human_merge_pr_number: process\.env\.HUMAN_MERGE_PR_NUMBER/);
  assert.match(bootstrap, /trusted_rail_run_id: process\.env\.TRUSTED_RAIL_RUN_ID/);
  assert.match(bootstrap, /trusted_rail_run_attempt: process\.env\.TRUSTED_RAIL_RUN_ATTEMPT/);
  assert.match(bootstrap, /business_evidence_issue_number: process\.env\.BUSINESS_EVIDENCE_ISSUE_NUMBER/);
});

test("Trusted LEARN Source 성공 후 Read-only AI LEARN을 자동 dispatch한다", () => {
  assert.match(learnSource, /\n  dispatch_learn:\n/);
  assert.match(learnSource, /needs: source/);
  assert.match(learnSource, /actions: write/);
  assert.match(learnSource, /workflow_id: 'learn\.yml'/);
  assert.match(learnSource, /source_run_id: String\(runId\)/);
  assert.match(learnSource, /completed_cycle_artifact_name: completedArtifact/);
  assert.match(learnSource, /learn_input_artifact_name: inputArtifact/);
});

test("Read-only AI LEARN finalize 성공 후 Trusted Improvement Candidate를 자동 dispatch한다", () => {
  assert.match(learn, /report_artifact_name: \$\{\{ steps\.finalize\.outputs\.report_artifact_name \}\}/);
  assert.match(learn, /\n  dispatch_candidate:\n/);
  assert.match(learn, /needs: \[prepare, finalize\]/);
  assert.match(learn, /actions: write/);
  assert.match(learn, /workflow_id: 'improvement-candidate\.yml'/);
  assert.match(learn, /learn_report_artifact_name: reportArtifact/);
  assert.match(learn, /source_run_id: String\(sourceRunId\)/);
  assert.match(learn, /learn_input_artifact_name: inputArtifact/);
});

test("자동 loop의 authority는 Candidate에서 멈추고 PLAN/IMPLEMENT/Merge를 자동 시작하지 않는다", () => {
  assert.match(candidate, /proposal-only/);
  assert.match(candidateSource, /authority: "proposal-only"/);
  assert.match(candidateSource, /decision: "pending-human"/);
  assert.doesNotMatch(candidate, /workflow_id: 'plan|workflow_id: 'implement|pulls\.merge|enablePullRequestAutoMerge/);
  assert.doesNotMatch(learn, /workflow_id: 'plan|workflow_id: 'implement|pulls\.merge|enablePullRequestAutoMerge/);
  assert.doesNotMatch(learnSource, /workflow_id: 'plan|workflow_id: 'implement|pulls\.merge|enablePullRequestAutoMerge/);
  assert.doesNotMatch(bootstrap, /workflow_id: 'plan|workflow_id: 'implement|pulls\.merge|enablePullRequestAutoMerge/);
});

test("자동 loop는 Framework 자체 개선이 아니라 App improvement evidence 경계를 유지한다", () => {
  assert.match(learnSource, /APP_EVIDENCE_JSON/);
  assert.match(learnSource, /BUSINESS_EVIDENCE_JSON/);
  assert.doesNotMatch(bootstrap, /self-improvement-mvp/);
  assert.doesNotMatch(bootstrap, /Framework repo 수정|Framework self-improvement/);
});
