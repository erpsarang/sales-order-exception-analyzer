import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/learn.yml", "utf8");
const learnerSection =
  workflow.split("\n  learner:\n")[1]?.split("\n  learn_usage:\n")[0] ?? "";
const usageSection =
  workflow.split("\n  learn_usage:\n")[1]?.split("\n  finalize:\n")[0] ?? "";
const finalizeSection =
  workflow.split("\n  finalize:\n")[1]?.split("\n  dispatch_candidate:\n")[0] ?? "";

test("read-only LEARN은 Luna + medium reasoning으로 명시 고정한다", () => {
  assert.match(learnerSection, /uses: openai\/codex-action@v1/);
  assert.match(learnerSection, /model: gpt-5\.6-luna/);
  assert.match(learnerSection, /effort: medium/);
  assert.match(learnerSection, /working-directory: \$\{\{ runner\.temp \}\}\/learn-neutral/);
  assert.match(learnerSection, /permission-profile: ":read-only"/);
});

test("LEARN은 Codex JSONL usage를 trusted artifact로 기록한 뒤 finalize한다", () => {
  assert.match(learnerSection, /codex-args: '\["--json","-c","project_doc_max_bytes=0"\]'/);
  assert.match(usageSection, /needs: \[prepare, learner\]/);
  assert.match(usageSection, /attempts\/\{attempt_number\}\/jobs/);
  assert.match(usageSection, /isolated read-only AI Learner/);
  assert.match(usageSection, /actions\/jobs\/\$\{LEARNER_JOB_ID\}\/logs/);
  assert.match(usageSection, /ai-usage-handler\.ts/);
  assert.match(usageSection, /AI_USAGE_STAGE: learn/);
  assert.match(usageSection, /learn-usage\.json/);
  assert.doesNotMatch(usageSection, /openai-api-key|codex-action/);
  assert.match(finalizeSection, /needs: \[prepare, learner, learn_usage\]/);
  assert.match(finalizeSection, /needs\.learn_usage\.result == 'success'/);
});

test("trusted LEARN provenance도 실제 Learner model identity를 동일하게 기록한다", () => {
  assert.match(workflow, /LEARNER_MODEL: gpt-5\.6-luna/);
  assert.doesNotMatch(workflow, /LEARNER_MODEL: action-default/);
});

test("LEARN model pin은 구현 권한이나 Auto Merge를 추가하지 않는다", () => {
  assert.doesNotMatch(learnerSection, /contents: write|pull-requests: write|issues: write/);
  assert.doesNotMatch(workflow, /auto-merge|AUTO_MERGE/);
});
