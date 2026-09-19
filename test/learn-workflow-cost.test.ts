import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/learn.yml", "utf8");
const learnerSection =
  workflow.split("\n  learner:\n")[1]?.split("\n  finalize:\n")[0] ?? "";
const finalizeSection =
  workflow.split("\n  finalize:\n")[1]?.split("\n  dispatch_candidate:\n")[0] ?? "";

test("read-only LEARN은 Luna + medium reasoning으로 명시 고정한다", () => {
  assert.match(learnerSection, /uses: openai\/codex-action@v1/);
  assert.match(learnerSection, /model: gpt-5\.6-luna/);
  assert.match(learnerSection, /effort: medium/);
  assert.match(learnerSection, /working-directory: \$\{\{ runner\.temp \}\}\/learn-neutral/);
  assert.match(learnerSection, /permission-profile: ":read-only"/);
});

test("LEARN usage는 같은 Learner job의 fresh CODEX_HOME session에서 기록한다", () => {
  assert.match(learnerSection, /codex-home: \$\{\{ runner\.temp \}\}\/learn-codex-home/);
  assert.match(learnerSection, /codex-args: '\["-c","project_doc_max_bytes=0"\]'/);
  assert.doesNotMatch(learnerSection, /--json/);

  const outputArtifactIndex = learnerSection.indexOf("untrusted Learner output 저장");
  const usageIndex = learnerSection.indexOf("CODEX_HOME persisted LEARN usage exact 기록");
  assert.ok(outputArtifactIndex >= 0);
  assert.ok(usageIndex > outputArtifactIndex);

  assert.match(learnerSection, /ai-usage-rollout-handler\.ts/);
  assert.match(
    learnerSection,
    /CODEX_HOME_PATH: \$\{\{ runner\.temp \}\}\/learn-codex-home/,
  );
  assert.match(learnerSection, /AI_USAGE_STAGE: learn/);
  assert.match(learnerSection, /AI_USAGE_JOB_NAME: learner/);
  assert.match(learnerSection, /learn-usage\/learn-usage\.json/);
  assert.match(learnerSection, /trusted LEARN usage artifact 저장/);

  assert.doesNotMatch(workflow, /\n  learn_usage:\n/);
  assert.doesNotMatch(workflow, /actions\/jobs\/\$\{LEARNER_JOB_ID\}\/logs/);
  assert.doesNotMatch(workflow, /completed AI Learner job log 다운로드/);
  assert.match(finalizeSection, /needs: \[prepare, learner\]/);
  assert.doesNotMatch(finalizeSection, /learn_usage/);
});

test("same-job telemetry 전에 비싼 Learner 결과를 먼저 artifact로 보존한다", () => {
  const outputArtifactIndex = learnerSection.indexOf("untrusted Learner output 저장");
  const parserCheckoutIndex = learnerSection.indexOf("trusted usage parser checkout");
  assert.ok(outputArtifactIndex >= 0);
  assert.ok(parserCheckoutIndex > outputArtifactIndex);
});

test("trusted LEARN provenance도 실제 Learner model identity를 동일하게 기록한다", () => {
  assert.match(workflow, /LEARNER_MODEL: gpt-5\.6-luna/);
  assert.doesNotMatch(workflow, /LEARNER_MODEL: action-default/);
});

test("LEARN usage 수집은 구현 권한이나 Auto Merge를 추가하지 않는다", () => {
  assert.match(learnerSection, /permissions:\n      contents: read/);
  assert.doesNotMatch(
    learnerSection,
    /contents: write|pull-requests: write|issues: write|actions: write/,
  );
  assert.doesNotMatch(workflow, /auto-merge|AUTO_MERGE/);
});
