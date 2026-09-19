import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/learn.yml", "utf8");
const learnerSection =
  workflow.split("\n  learner:\n")[1]?.split("\n  finalize:\n")[0] ?? "";

test("read-only LEARN은 Luna + medium reasoning으로 명시 고정한다", () => {
  assert.match(learnerSection, /uses: openai\/codex-action@v1/);
  assert.match(learnerSection, /model: gpt-5\.6-luna/);
  assert.match(learnerSection, /effort: medium/);
  assert.match(learnerSection, /working-directory: \$\{\{ runner\.temp \}\}\/learn-neutral/);
  assert.match(learnerSection, /permission-profile: ":read-only"/);
});

test("trusted LEARN provenance도 실제 Learner model identity를 동일하게 기록한다", () => {
  assert.match(workflow, /LEARNER_MODEL: gpt-5\.6-luna/);
  assert.doesNotMatch(workflow, /LEARNER_MODEL: action-default/);
});

test("LEARN model pin은 구현 권한이나 Auto Merge를 추가하지 않는다", () => {
  assert.doesNotMatch(learnerSection, /contents: write|pull-requests: write|issues: write/);
  assert.doesNotMatch(workflow, /auto-merge|AUTO_MERGE/);
});
