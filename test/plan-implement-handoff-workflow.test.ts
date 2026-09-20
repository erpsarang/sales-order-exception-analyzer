import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/plan-implement-handoff.yml", "utf8");
const handler = readFileSync("src/self-improvement/plan-implement-handoff-handler.ts", "utf8");

test("handoff는 Trusted PLAN_AUTHORIZE 또는 exact PLAN-재개 rebind만 source로 사용한다", () => {
  assert.match(workflow, /workflows:\s*\["Trusted PLAN_AUTHORIZE"\]/);
  assert.match(workflow, /issue_comment:\n\s+types: \[created\]/);
  assert.match(workflow, /github\.event\.comment\.body == 'PLAN-재개'/);
  assert.match(workflow, /self-improvement:PLAN_AUTHORIZE/);
  assert.match(workflow, /no trusted PLAN_AUTHORIZE marker exists for PLAN rebind/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/plan-authorize\.yml'/);
  assert.match(workflow, /workflow_run\.event == 'issue_comment'/);
  assert.match(workflow, /REBIND_TARGET_SHA:/);
  assert.doesNotMatch(workflow, /workflows:\s*\["Trusted AUTHORIZE"\]/);
  assert.doesNotMatch(workflow, /SI-승인/);
});

test("handoff workflow는 read-only 권한이고 Worker나 Merge를 실행하지 않는다", () => {
  assert.match(workflow, /permissions:\s*\{\}/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+actions: read\n\s+issues: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /openai\/codex-action/);
  assert.doesNotMatch(workflow, /git push/);
  assert.doesNotMatch(workflow, /pulls\.create/);
});

test("rerun replay는 duplicate handoff 대신 no-op을 명시한다", () => {
  assert.match(workflow, /prior\.length === 1 && matches\.length === 1/);
  assert.match(workflow, /handoff is a no-op/);
  assert.match(workflow, /authorizeJobs\[0\]\.conclusion === 'skipped'/);
});

test("production artifact에는 Contract, Context, Worker input과 provenance manifest가 함께 저장된다", () => {
  for (const file of ["contract.json", "context.json", "prompt.md", "schema.json", "handoff.json", "source.json"]) {
    assert.match(workflow, new RegExp(file.replace(".", "\\.")));
  }
  assert.match(workflow, /exact approved base SHA checkout/);
  assert.match(workflow, /OBSERVED_BASE_SHA/);
});


test("handoff는 수동 PLAN과 자동 issues PLAN만 승인 PLAN identity로 허용한다", () => {
  assert.match(handler, /\["workflow_dispatch", "issues"\]\.includes\(planRun\.event\)/);
  assert.match(handler, /planRun\.name !== "Read-only AI PLAN"/);
  assert.match(handler, /planRun\.path !== PLAN_WORKFLOW_PATH/);
  assert.match(handler, /planRun\.conclusion !== "success"/);
  assert.doesNotMatch(handler, /\["workflow_dispatch", "issues", "schedule"/);
});

test("Step 2A: 기존 Handoff artifact는 그대로 6개 파일이고 lineage.json은 shadow sibling artifact로만 발행된다", () => {
  const mainUploadStart = workflow.indexOf("- name: Trusted ImplementContract / Context Pack artifact 저장");
  const shadowStart = workflow.indexOf("- name: Canonical Execution Lineage shadow 생성");
  const shadowUploadStart = workflow.indexOf("- name: Canonical Execution Lineage shadow artifact 저장");
  assert.ok(mainUploadStart > 0 && shadowStart > mainUploadStart && shadowUploadStart > shadowStart);

  // 기존 artifact: 이름과 exact 6개 path는 그대로이고 lineage를 포함하지 않는다.
  const shadowCommentStart = workflow.indexOf("# Canonical Execution Lineage Step 2A");
  assert.ok(shadowCommentStart > mainUploadStart && shadowCommentStart < shadowStart);
  const mainUpload = workflow.slice(mainUploadStart, shadowCommentStart);
  assert.match(mainUpload, /name: \$\{\{ steps\.prepare\.outputs\.artifact_name \}\}\n/);
  const paths = [...mainUpload.matchAll(/\/plan-implement-handoff\/([a-z]+\.(?:json|md))/g)].map((match) => match[1]);
  assert.deepEqual(paths, ["contract.json", "context.json", "prompt.md", "schema.json", "handoff.json", "source.json"]);
  assert.doesNotMatch(mainUpload, /lineage/);

  // shadow 생성: 기존 upload 뒤에서, 실패해도 Handoff 결과를 바꾸지 않는다.
  const shadow = workflow.slice(shadowStart, shadowUploadStart);
  assert.match(shadow, /continue-on-error: true/);
  assert.match(shadow, /plan-implement-handoff-handler\.ts lineage/);
  assert.match(shadow, /HANDOFF_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(shadow, /HANDOFF_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(shadow, /HANDOFF_EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(shadow, /EXPECTED_CONTROL_SHA: \$\{\{ steps\.source\.outputs\.control_sha \}\}/);
  assert.match(shadow, /OBSERVED_CONTROL_SHA="\$\(git rev-parse HEAD\)"/);
  assert.match(shadow, /LINEAGE_OUTPUT: \$\{\{ runner\.temp \}\}\/plan-implement-handoff-lineage\n/);

  // shadow artifact: 별도 이름(-lineage), lineage.json 하나만.
  const shadowUpload = workflow.slice(shadowUploadStart);
  assert.match(shadowUpload, /steps\.lineage\.outcome == 'success'/);
  assert.match(shadowUpload, /continue-on-error: true/);
  assert.match(shadowUpload, /name: \$\{\{ steps\.prepare\.outputs\.artifact_name \}\}-lineage\n/);
  assert.match(shadowUpload, /path: \$\{\{ runner\.temp \}\}\/plan-implement-handoff-lineage\/lineage\.json\n/);
  assert.equal((workflow.match(/uses: actions\/upload-artifact@v4/g) ?? []).length, 2);
});

test("Step 2A: handler의 lineage command는 prepare/context와 분리되어 있고 기존 파일을 쓰지 않는다", () => {
  assert.match(handler, /else if \(command === "lineage"\) buildLineage\(\);/);
  const start = handler.indexOf("function buildLineage(): void {");
  const end = handler.indexOf("const command = process.argv[2];");
  assert.ok(start > 0 && end > start);
  const body = handler.slice(start, end);
  assert.equal((body.match(/writeFileSync\(/g) ?? []).length, 1);
  assert.match(body, /writeFileSync\(join\(lineageDirectory, HANDOFF_LINEAGE_FILE\)/);
  assert.doesNotMatch(body, /api<|fetch\(/);
  // prepare/context는 lineage를 모른다.
  assert.doesNotMatch(handler.slice(0, start), /createHandoffLineage\(/);
});

test("Step 2A: downstream(Worker/Bridge/Recovery/Rail)은 lineage를 읽지 않는다", () => {
  const untouched = [
    ".github/workflows/plan-implement-worker.yml",
    ".github/workflows/plan-candidate-bridge.yml",
    ".github/workflows/plan-worker-recovery-preflight.yml",
    ".github/workflows/trusted-rail.yml",
    "src/self-improvement/plan-implement-worker-handler.ts",
    "src/self-improvement/plan-implement-worker.ts",
    "src/self-improvement/plan-candidate-bridge-handler.ts",
    "src/self-improvement/plan-candidate-bridge.ts",
    "src/self-improvement/plan-worker-ci-repair-handler.ts",
    "src/self-improvement/seal.ts",
  ];
  for (const path of untouched) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /lineage\.json|handoff-lineage|-lineage\b/, path);
  }
  // Worker/Bridge/CI-repair는 여전히 Handoff artifact의 exact 6개 file set을 요구한다.
  for (const path of [
    "src/self-improvement/plan-implement-worker-handler.ts",
    "src/self-improvement/plan-candidate-bridge-handler.ts",
    "src/self-improvement/plan-worker-ci-repair-handler.ts",
  ]) {
    const source = readFileSync(path, "utf8");
    const block = /const HANDOFF_FILES = \[([^\]]+)\]/.exec(source);
    assert.ok(block, path);
    const files = [...block[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(files, ["context.json", "contract.json", "handoff.json", "prompt.md", "schema.json", "source.json"], path);
  }
});
