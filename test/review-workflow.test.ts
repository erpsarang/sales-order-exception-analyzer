import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const trustedRail = await readFile(".github/workflows/trusted-rail.yml", "utf8");
const reviewWorkflow = await readFile(".github/workflows/semantic-review.yml", "utf8");
const prepareSection = reviewWorkflow.split("\n  review_prepare:\n")[1]?.split("\n  review_agent:\n")[0] ?? "";
const agentSection = reviewWorkflow.split("\n  review_agent:\n")[1]?.split("\n  review_usage:\n")[0] ?? "";
const usageSection = reviewWorkflow.split("\n  review_usage:\n")[1]?.split("\n  review_finalize:\n")[0] ?? "";
const finalizeSection = reviewWorkflow.split("\n  review_finalize:\n")[1] ?? "";

test("Trusted Rail은 VERIFY 성공 뒤 Semantic REVIEW reusable workflow를 동기 호출한다", () => {
  assert.match(trustedRail, /\n  review:\n/);
  assert.match(trustedRail, /needs: verify_finalize/);
  assert.match(trustedRail, /needs\.verify_finalize\.result == 'success'/);
  assert.match(trustedRail, /uses: \.\/\.github\/workflows\/semantic-review\.yml/);
  assert.doesNotMatch(reviewWorkflow, /workflow_run:/);
  assert.match(reviewWorkflow, /workflow_call:/);
});

test("REVIEW는 trusted prepare → isolated AI reviewer → trusted usage ledger → trusted finalize로 runner를 분리한다", () => {
  assert.match(reviewWorkflow, /\n  review_prepare:\n/);
  assert.match(reviewWorkflow, /\n  review_agent:\n/);
  assert.match(reviewWorkflow, /\n  review_usage:\n/);
  assert.match(reviewWorkflow, /\n  review_finalize:\n/);
  assert.match(agentSection, /needs: review_prepare/);
  assert.match(usageSection, /needs: \[review_prepare, review_agent\]/);
  assert.match(finalizeSection, /needs: \[review_prepare, review_agent, review_usage\]/);
  assert.match(finalizeSection, /needs\.review_usage\.result == 'success'/);
});

test("trusted REVIEW prepare/finalize는 read-only이며 reviewer에도 write 권한이 없다", () => {
  assert.match(prepareSection, /permissions:\n      contents: read\n      actions: read/);
  assert.match(agentSection, /permissions:\n      contents: read/);
  assert.match(finalizeSection, /permissions:\n      contents: read\n      actions: read/);
  assert.match(usageSection, /permissions:\n      contents: read\n      actions: read/);
  for (const section of [prepareSection, agentSection, usageSection, finalizeSection]) {
    assert.doesNotMatch(section, /contents: write|pull-requests: write|issues: write/);
  }
});

test("AI reviewer는 exact verified SHA를 credential-free checkout하고 neutral workspace에서 read-only로 실행한다", () => {
  assert.match(agentSection, /ref: \$\{\{ needs\.review_prepare\.outputs\.verified_head_sha \}\}/);
  assert.match(agentSection, /persist-credentials: false/);
  assert.match(agentSection, /GITHUB_TOKEN: ""/);
  assert.match(agentSection, /GH_TOKEN: ""/);
  assert.match(agentSection, /NODE_AUTH_TOKEN: ""/);
  assert.match(agentSection, /NPM_TOKEN: ""/);
  assert.match(agentSection, /working-directory: review-neutral/);
  assert.match(agentSection, /permission-profile: ":read-only"/);
  assert.match(agentSection, /allow-bot-users: "github-actions\[bot\]"/);
  assert.doesNotMatch(agentSection, /allow-bots:\s*true/);
  assert.match(agentSection, /safety-strategy: drop-sudo/);
  assert.match(agentSection, /project_doc_max_bytes=0/);
});

test("Semantic REVIEW는 AI 호출 전에 bounded patch를 만들고 full checkout을 폐기한다", () => {
  assert.match(prepareSection, /base_sha: \${\{ steps\.review_source\.outputs\.base_sha \}\}/);
  assert.match(agentSection, /fetch-depth: 0/);
  assert.match(agentSection, /MAX_CHANGED_FILES: "12"/);
  assert.match(agentSection, /MAX_PATCH_BYTES: "65536"/);
  assert.match(agentSection, /git diff --name-only -z --diff-filter=ACDMRT/);
  assert.match(agentSection, /refuses binary diffs before AI invocation/);
  assert.match(agentSection, /review-neutral\/review-context\/patch\.diff/);
  assert.match(agentSection, /rm -rf review-target/);
  assert.match(agentSection, /test ! -e review-target/);
  assert.match(agentSection, /model: gpt-5\.6-terra/);
  assert.match(agentSection, /effort: medium/);
  assert.doesNotMatch(agentSection, /effort: high/);
});

test("Semantic REVIEW는 persisted Codex rollout을 trusted artifact usage로 기록한다", () => {
  assert.match(agentSection, /codex-args: '\["--json","-c","project_doc_max_bytes=0"\]'/);
  assert.match(agentSection, /semantic-review-codex-home\/sessions/);
  assert.match(agentSection, /semantic-review-rollout-issue-/);
  assert.match(usageSection, /persisted Semantic Reviewer rollout artifact 다운로드/);
  assert.match(usageSection, /semantic-review-rollout-issue-/);
  assert.match(usageSection, /ai-usage-rollout-handler\.ts/);
  assert.match(usageSection, /CODEX_HOME_PATH:/);
  assert.match(usageSection, /AI_USAGE_JOB_NAME: isolated AI Semantic Reviewer/);
  assert.match(usageSection, /AI_USAGE_STAGE: semantic-review/);
  assert.match(usageSection, /ai-usage-/);
  assert.doesNotMatch(usageSection, /actions\/jobs\/.*\/logs|CODEX_JOB_LOG|ai-usage-handler\.ts/);
  assert.doesNotMatch(usageSection, /openai-api-key|codex-action/);
});

test("reviewer는 target project code를 실행하지 않고 structured output schema를 사용한다", () => {
  assert.doesNotMatch(agentSection, /working-directory: review-target\n\s+run: npm (?:ci|test|run)/);
  assert.match(agentSection, /output-schema-file:/);
  assert.match(agentSection, /output-file:/);
  assert.match(agentSection, /reviewer-output-issue-/);
});

test("fresh trusted finalize는 VERIFY와 AUTHORIZE를 재검증하고 raw reviewer artifact만 별도로 검증한다", () => {
  assert.match(finalizeSection, /VERIFY provenance 재검증 및 AUTHORIZE source 재결정/);
  assert.match(finalizeSection, /원본 AUTHORIZE artifact 재다운로드/);
  assert.match(finalizeSection, /current 또는 이전 Reviewer output artifact 선택/);
  assert.match(finalizeSection, /review-handler\.ts finalize/);
  assert.match(finalizeSection, /review-provenance-issue-/);
  assert.doesNotMatch(finalizeSection, /needs\.review_agent\.outputs/);
});

test("REVIEW는 push, PR 생성, Merge, Auto Merge를 수행하지 않는다", () => {
  assert.doesNotMatch(reviewWorkflow, /git\s+push|gh pr|pulls\.create|auto-merge|AUTO_MERGE/);
});
