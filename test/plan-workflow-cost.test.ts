import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/plan.yml", "utf8");
const plannerSection =
  workflow.split("\n      - name: Read-only bounded AI Planner")[1]?.split("\n      - name: Fresh Framework checkout", 1)[0] ?? "";

test("Read-only AI PLAN은 Terra + medium reasoning으로 명시 고정한다", () => {
  assert.match(plannerSection, /uses: openai\/codex-action@/);
  assert.match(plannerSection, /model: gpt-5\.6-terra/);
  assert.match(plannerSection, /effort: medium/);
  assert.match(plannerSection, /permission-profile: ":read-only"/);
  assert.match(plannerSection, /working-directory: \$\{\{ runner\.temp \}\}\/plan-neutral/);
  assert.match(plannerSection, /codex-home: \$\{\{ runner\.temp \}\}\/plan-codex-home/);
  assert.match(plannerSection, /project_doc_max_bytes=0/);
});

test("PLAN model pin은 write 권한이나 Auto Merge를 추가하지 않는다", () => {
  assert.doesNotMatch(plannerSection, /permission-profile: ":workspace"/);
  assert.doesNotMatch(workflow, /auto-merge|AUTO_MERGE/);
});


test("PLAN usage는 검증된 PLAN artifact 보존 뒤 trusted validation checkout에서 same-job 수집한다", () => {
  const storePlanIndex = workflow.indexOf("Store PLAN only");
  const usageIndex = workflow.indexOf("CODEX_HOME persisted PLAN usage exact 기록");
  const usageArtifactIndex = workflow.indexOf("trusted PLAN usage artifact 저장");

  assert.ok(storePlanIndex >= 0);
  assert.ok(usageIndex > storePlanIndex);
  assert.ok(usageArtifactIndex > usageIndex);

  assert.match(workflow, /working-directory: planner-control-validation[\s\S]*ai-usage-rollout-handler\.ts/);
  assert.match(workflow, /CODEX_HOME_PATH: \$\{\{ runner\.temp \}\}\/plan-codex-home/);
  assert.match(workflow, /AI_USAGE_STAGE: plan/);
  assert.match(workflow, /AI_USAGE_JOB_NAME: plan/);
  assert.match(workflow, /plan-usage\/plan-usage\.json/);
  assert.doesNotMatch(workflow, /actions\/jobs\/.*\/logs/);
  assert.doesNotMatch(workflow, /path: \$\{\{ runner\.temp \}\}\/plan-codex-home/);
});
