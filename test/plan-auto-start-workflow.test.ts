import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/plan.yml", "utf8");

test("업무 요구 Issue opened/reopened는 PLAN을 자동 시작한다", () => {
  assert.match(workflow, /issues:\s*\n\s*types: \[opened, reopened\]/);
  assert.match(workflow, /github\.event_name == 'issues'/);
  assert.match(workflow, /startsWith\(github\.event\.issue\.title, '\[업무 요구\]'\)/);
  assert.match(
    workflow,
    /ISSUE_NUMBER: \$\{\{ github\.event_name == 'issues' && github\.event\.issue\.number \|\| inputs\.issue_number \}\}/,
  );
});

test("기존 수동 workflow_dispatch와 Human PLAN 승인 경계는 유지한다", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /issue_number:/);
  assert.match(workflow, /required: true/);
  assert.match(workflow, /Leave human-readable PLAN pointer on requirement Issue/);
  assert.match(workflow, /AI가 계획을 제안했습니다\. 아직 구현 승인이 아닙니다\./);
});

test("일반 Issue는 제목 prefix 조건을 통과할 수 없다", () => {
  const planJob = workflow.split("\n  plan:\n")[1]?.split("\n  provenance:\n", 1)[0] ?? "";
  assert.match(planJob, /startsWith\(github\.event\.issue\.title, '\[업무 요구\]'\)/);
  assert.doesNotMatch(planJob, /\[Framework Start\]|\[Cost Ledger\]|\[사용자 피드백\]/);
});
