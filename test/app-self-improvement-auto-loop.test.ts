import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bootstrap = await readFile(".github/workflows/app-self-improvement.yml", "utf8");
const learnBridge = await readFile(".github/workflows/learn-auto-bridge.yml", "utf8");
const candidateBridge = await readFile(".github/workflows/candidate-auto-bridge.yml", "utf8");
const orchestrator = await readFile(".github/workflows/orchestrator.yml", "utf8");

test("App Self-Improvement는 실제 Human Merge PR close에서만 bootstrap된다", () => {
  assert.match(bootstrap, /pull_request:\n    types: \[closed\]/);
  assert.match(bootstrap, /github\.event\.pull_request\.merged == true/);
  assert.match(bootstrap, /github\.event\.pull_request\.base\.ref == github\.event\.repository\.default_branch/);
  assert.doesNotMatch(bootstrap, /workflow_dispatch:/);
});

test("Human Merge PR은 MERGE_READY exact SHA와 Trusted Rail provenance를 함께 요구한다", () => {
  assert.match(bootstrap, /ai-dev-framework:MERGE_READY issue=/);
  assert.match(bootstrap, /ai-dev-framework:TRUSTED_RAIL run-id=/);
  assert.match(bootstrap, /pr\.head\.ref !== `ai-publish\/issue-\$\{issueNumber\}`/);
  assert.match(bootstrap, /pr\.head\.sha !== reviewedSha/);
  assert.match(bootstrap, /trustedRun\.path !== '\.github\/workflows\/trusted-rail\.yml'/);
  assert.match(bootstrap, /expected one exact orchestration artifact/);

  assert.match(orchestrator, /TRUSTED_RAIL_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(orchestrator, /TRUSTED_RAIL_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(orchestrator, /ai-dev-framework:TRUSTED_RAIL run-id=/);
  assert.match(orchestrator, /orchestration-provenance-issue-/);
});

test("Business Feedback은 열린 [사용자 피드백] Issue가 정확히 하나일 때만 자동 선택한다", () => {
  assert.match(bootstrap, /state: 'open'/);
  assert.match(bootstrap, /issue\.title\.startsWith\('\[사용자 피드백\]'\)/);
  assert.match(bootstrap, /businessFeedback\.length === 0/);
  assert.match(bootstrap, /should_run', 'false'/);
  assert.match(bootstrap, /businessFeedback\.length !== 1/);
  assert.match(bootstrap, /core\.setFailed/);
});

test("bootstrap은 LEARN Source만 dispatch하며 구현/merge를 시작하지 않는다", () => {
  assert.match(bootstrap, /workflow_id: 'learn-source\.yml'/);
  assert.match(bootstrap, /business_evidence_issue_number/);
  assert.doesNotMatch(bootstrap, /workflow_id: 'implement\.yml'|workflow_id: 'plan\.yml'/);
  assert.doesNotMatch(bootstrap, /pulls\.merge|enablePullRequestAutoMerge|git\s+push/);
});

test("LEARN Bridge는 Trusted LEARN Source가 완전히 성공한 뒤 exact artifacts로 LEARN을 시작한다", () => {
  assert.match(learnBridge, /workflow_run:/);
  assert.match(learnBridge, /workflows: \["Trusted LEARN Source"\]/);
  assert.match(learnBridge, /types: \[completed\]/);
  assert.match(learnBridge, /workflow_run\.conclusion == 'success'/);
  assert.match(learnBridge, /run\.path !== '\.github\/workflows\/learn-source\.yml'/);
  assert.match(learnBridge, /completed-cycle-issue-/);
  assert.match(learnBridge, /learn-input-issue-/);
  assert.match(learnBridge, /completed\.length !== 1 \|\| input\.length !== 1/);
  assert.match(learnBridge, /workflow_id: 'learn\.yml'/);
});

test("Candidate Bridge는 LEARN completed success의 exact report에서 source identity를 추출한다", () => {
  assert.match(candidateBridge, /workflow_run:/);
  assert.match(candidateBridge, /workflows: \["Read-only AI LEARN"\]/);
  assert.match(candidateBridge, /types: \[completed\]/);
  assert.match(candidateBridge, /run\.path !== '\.github\/workflows\/learn\.yml'/);
  assert.match(candidateBridge, /learn-report-issue-/);
  assert.match(candidateBridge, /reports\.length !== 1/);
  assert.match(candidateBridge, /report\?\.source\?\.inputPack/);
  assert.match(candidateBridge, /learn-input-issue-/);
  assert.match(candidateBridge, /workflow_id: 'improvement-candidate\.yml'/);
});

test("자동 loop는 Candidate까지만 가며 Human authority 경계를 유지한다", () => {
  for (const workflow of [bootstrap, learnBridge, candidateBridge]) {
    assert.match(workflow, /permissions: \{\}/);
    assert.doesNotMatch(workflow, /pull-requests: write|issues: write|contents: write/);
    assert.doesNotMatch(workflow, /pulls\.create|pulls\.merge|enablePullRequestAutoMerge|git\s+push/);
  }
  assert.doesNotMatch(candidateBridge, /workflow_id: 'plan\.yml'|workflow_id: 'implement\.yml'/);
});
