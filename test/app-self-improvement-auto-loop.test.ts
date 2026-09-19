import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const bootstrap = await readFile(".github/workflows/app-self-improvement.yml", "utf8");
const learnSource = await readFile(".github/workflows/learn-source.yml", "utf8");
const learn = await readFile(".github/workflows/learn.yml", "utf8");
const candidate = await readFile(".github/workflows/improvement-candidate.yml", "utf8");
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

test("Business Feedback 0건은 runtime-only LEARN, 1건은 포함, 2건 이상은 fail-closed한다", () => {
  assert.match(bootstrap, /state: 'open'/);
  assert.match(bootstrap, /issue\.title\.startsWith\('\[사용자 피드백\]'\)/);
  assert.match(bootstrap, /businessFeedback\.length === 0/);
  assert.match(bootstrap, /App Runtime Evidence만으로 기술\/품질 LEARN/);
  assert.match(bootstrap, /businessFeedback\.length > 1/);
  assert.match(bootstrap, /core\.setFailed/);
  assert.match(
    bootstrap,
    /businessFeedback\.length === 1 \? String\(businessFeedback\[0\]\.number\) : ''/,
  );
  assert.doesNotMatch(bootstrap, /Issue가 없어 이번 cycle은 no-op/);
});

test("bootstrap은 LEARN Source만 dispatch하며 구현/merge를 시작하지 않는다", () => {
  assert.match(bootstrap, /workflow_id: 'learn-source\.yml'/);
  assert.match(bootstrap, /business_evidence_issue_number/);
  assert.doesNotMatch(bootstrap, /workflow_id: 'implement\.yml'|workflow_id: 'plan\.yml'/);
  assert.doesNotMatch(bootstrap, /pulls\.merge|enablePullRequestAutoMerge|git\s+push/);
});

test("Trusted LEARN Source는 source job 성공 뒤 LEARN을 workflow_dispatch한다", () => {
  assert.match(learnSource, /\n  dispatch_learn:\n/);
  assert.match(learnSource, /needs: source/);
  assert.match(learnSource, /needs\.source\.result == 'success'/);
  assert.match(learnSource, /actions: write/);
  assert.match(learnSource, /workflow_id: 'learn\.yml'/);
  assert.match(learnSource, /source_run_id: process\.env\.SOURCE_RUN_ID/);
  assert.match(learnSource, /completed_cycle_artifact_name: process\.env\.COMPLETED_CYCLE_ARTIFACT_NAME/);
  assert.match(learnSource, /learn_input_artifact_name: process\.env\.LEARN_INPUT_ARTIFACT_NAME/);
});

test("LEARN은 dispatch race를 bounded wait한 뒤 source completed-success를 exact 검증한다", () => {
  assert.match(learn, /for \(let poll = 0; poll < 12; poll \+= 1\)/);
  assert.match(learn, /await sleep\(5000\)/);
  assert.match(learn, /source run must reach exact completed success within bounded wait/);
  assert.match(learn, /run\.path !== '\.github\/workflows\/learn-source\.yml'/);
  assert.match(learn, /run\.head_branch !== context\.payload\.repository\.default_branch/);
});

test("validated LEARN은 Candidate를 workflow_dispatch하고 Candidate가 LEARN completed-success를 bounded wait한다", () => {
  assert.match(learn, /\n  dispatch_candidate:\n/);
  assert.match(learn, /needs: \[prepare, finalize\]/);
  assert.match(learn, /needs\.finalize\.result == 'success'/);
  assert.match(learn, /workflow_id: 'improvement-candidate\.yml'/);
  assert.match(learn, /LEARN_REPORT_ARTIFACT_NAME: \$\{\{ needs\.finalize\.outputs\.report_artifact_name \}\}/);

  assert.match(candidate, /for \(let poll = 0; poll < 12; poll \+= 1\)/);
  assert.match(candidate, /must reach exact completed success within bounded wait/);
  assert.match(candidate, /'\.github\/workflows\/learn\.yml'/);
  assert.match(candidate, /'\.github\/workflows\/learn-source\.yml'/);
});

test("GITHUB_TOKEN 재귀 방지에 취약한 workflow_run bridge는 제거한다", async () => {
  await assert.rejects(access(".github/workflows/learn-auto-bridge.yml"));
  await assert.rejects(access(".github/workflows/candidate-auto-bridge.yml"));
  assert.doesNotMatch(learnSource, /workflow_run:/);
  assert.doesNotMatch(learn, /workflow_run:/);
});

test("자동 loop는 Candidate까지만 가며 Human authority 경계를 유지한다", () => {
  for (const workflow of [bootstrap, learnSource, learn, candidate]) {
    assert.match(workflow, /permissions: \{\}/);
    assert.doesNotMatch(workflow, /pulls\.merge|enablePullRequestAutoMerge|git\s+push/);
  }
  assert.doesNotMatch(learnSource, /workflow_id: 'plan\.yml'|workflow_id: 'implement\.yml'/);
  assert.doesNotMatch(learn, /workflow_id: 'plan\.yml'|workflow_id: 'implement\.yml'/);
  assert.doesNotMatch(candidate, /workflow_id: 'plan\.yml'|workflow_id: 'implement\.yml'/);
});
