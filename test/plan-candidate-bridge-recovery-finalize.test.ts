import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { BRIDGE_RECOVERY_DRIFT_POLICY, classifyDrift } from "../src/self-improvement/lineage/drift.js";
import {
  classifyValidationWorktree,
  createCanonicalCandidatePatch,
  parsePorcelainStatus,
  type CandidatePatchFile,
} from "../src/self-improvement/plan-bridge-patch.js";
import { validateBridgeTrustedCodeIdentity } from "../src/self-improvement/plan-candidate-bridge.js";

const bridgeSource = readFileSync(
  new URL("../src/self-improvement/plan-candidate-bridge.ts", import.meta.url),
  "utf8",
);
const handlerSource = readFileSync(
  new URL("../src/self-improvement/plan-candidate-bridge-handler.ts", import.meta.url),
  "utf8",
);

test("bridge provenance 생성은 trusted recovery guard를 내부 재검증까지 전달한다", () => {
  assert.match(
    bridgeSource,
    /readonly recoveryGuard\?: TrustedRecoveryCompareGuard;/,
  );
  assert.match(
    bridgeSource,
    /\.\.\.\(input\.recoveryGuard \? \{ recoveryGuard: input\.recoveryGuard \} : \{\}\),/,
  );
});

test("finalize는 workflow가 검증한 recovery guard를 provenance 생성에 전달한다", () => {
  const finalize = handlerSource.split("async function finalize(): Promise<void> {")[1] ?? "";
  assert.match(finalize, /const recoveryGuard = trustedRecoveryGuard\(\);/);
  assert.match(
    finalize,
    /\.\.\.\(recoveryGuard \? \{ recoveryGuard \} : \{\}\),/,
  );
});

// ---------------------------------------------------------------------------
// canonical patch 계약 (#176 Bridge run 35516108102: npm run build가 만든 dist/ 때문에 실패)
// ---------------------------------------------------------------------------

function run(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** exact base commit + candidate가 적용된 validation worktree를 만든다. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "bridge-patch-test-"));
  run(root, "init", "-q");
  write(root, ".gitignore", "node_modules/\n");
  write(root, "package.json", '{"name":"app"}\n');
  write(root, "package-lock.json", '{"lockfileVersion":3}\n');
  write(root, "src/order-analysis-cli.ts", "export const cli = 1;\n");
  write(root, "README.md", "# app\n");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "base");
  const baseSha = run(root, "rev-parse", "HEAD").trim();
  const candidate: CandidatePatchFile[] = [
    { path: "package.json", content: '{"name":"app","scripts":{"build":"vite build"}}\n' },
    { path: "package-lock.json", content: '{"lockfileVersion":3,"packages":{}}\n' },
    { path: "src/web-main.ts", content: "export const main = 1;\n" },
    { path: "index.html", content: "<!doctype html>\n" },
  ];
  for (const file of candidate) write(root, file.path, file.content);
  return { root, baseSha, candidate, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function buildArtifacts(root: string): void {
  write(root, "dist/index.html", "<!doctype html><script src=assets/index-PubxuhC1.js></script>\n");
  write(root, "dist/assets/index-PubxuhC1.js", "console.log(1)\n");
  write(root, "dist/assets/index-C2569_aL.css", "body{}\n");
  write(root, "node_modules/.vite/cache.json", "{}\n"); // ignored
}

test("canonical patch는 candidate exact paths만 담고, candidate 밖 untracked build artifact는 제외한다", () => {
  const clean = repo();
  const withBuild = repo();
  try {
    buildArtifacts(withBuild.root);
    const a = createCanonicalCandidatePatch(clean.root, clean.baseSha, clean.candidate);
    const b = createCanonicalCandidatePatch(withBuild.root, withBuild.baseSha, withBuild.candidate);

    assert.deepEqual([...a.classification.excludedUntrackedPaths], []);
    assert.deepEqual([...b.classification.excludedUntrackedPaths], ["dist/assets/index-C2569_aL.css", "dist/assets/index-PubxuhC1.js", "dist/index.html"]);
    assert.deepEqual([...b.classification.candidatePaths], ["index.html", "package-lock.json", "package.json", "src/web-main.ts"]);

    // build artifact가 있든 없든 canonical patch는 byte-identical → candidatePatchDigest / provenance가 artifact에 영향받지 않는다.
    assert.equal(b.patch.toString("utf8"), a.patch.toString("utf8"));
    const text = b.patch.toString("utf8");
    assert.doesNotMatch(text, /dist\//);
    const patched = [...text.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]).sort();
    assert.deepEqual(patched, ["index.html", "package-lock.json", "package.json", "src/web-main.ts"]);

    // patch를 exact base의 clean checkout에 적용하면 candidate 내용 그대로가 되고 dist는 생기지 않는다.
    const verify = mkdtempSync(join(tmpdir(), "bridge-patch-verify-"));
    try {
      run(withBuild.root, "worktree", "add", "-q", "--detach", join(verify, "w"), withBuild.baseSha);
      writeFileSync(join(verify, "candidate.patch"), b.patch);
      run(join(verify, "w"), "apply", "--binary", join(verify, "candidate.patch"));
      for (const file of withBuild.candidate) assert.equal(readFileSync(join(verify, "w", file.path), "utf8"), file.content, file.path);
      assert.equal(readdirSync(join(verify, "w")).includes("dist"), false);
      run(withBuild.root, "worktree", "remove", "--force", join(verify, "w"));
    } finally { rmSync(verify, { recursive: true, force: true }); }
  } finally { clean.cleanup(); withBuild.cleanup(); }
});

test("candidate 밖의 tracked 파일이 검증 중 수정/삭제/stage 되면 fail-closed", () => {
  const cases: Array<[string, (root: string) => void, RegExp]> = [
    ["modified", (root) => write(root, "README.md", "# changed by build\n"), /modified tracked files outside the candidate: M:README\.md/],
    ["deleted", (root) => rmSync(join(root, "src/order-analysis-cli.ts")), /outside the candidate: D:src\/order-analysis-cli\.ts/],
    ["staged new file", (root) => { write(root, "dist/x.js", "1\n"); run(root, "add", "dist/x.js"); }, /outside the candidate: A:dist\/x\.js/],
    ["renamed", (root) => { run(root, "mv", "README.md", "README2.md"); }, /outside the candidate: R:README2\.md/],
  ];
  for (const [name, mutate, expected] of cases) {
    const f = repo();
    try {
      buildArtifacts(f.root);
      mutate(f.root);
      assert.throws(() => createCanonicalCandidatePatch(f.root, f.baseSha, f.candidate), expected, name);
    } finally { f.cleanup(); }
  }
});

test("검증 명령이 candidate 파일 내용을 바꾸거나 없애면 fail-closed (patch는 candidateDigest의 내용 그대로여야 한다)", () => {
  const changed = repo();
  try {
    write(changed.root, "index.html", "<!doctype html><!-- rewritten by build -->\n");
    assert.throws(() => createCanonicalCandidatePatch(changed.root, changed.baseSha, changed.candidate), /validation changed candidate file content: index\.html/);
  } finally { changed.cleanup(); }

  const lockChanged = repo();
  try {
    write(lockChanged.root, "package-lock.json", '{"lockfileVersion":3,"packages":{"":{}}}\n');
    assert.throws(() => createCanonicalCandidatePatch(lockChanged.root, lockChanged.baseSha, lockChanged.candidate), /validation changed candidate file content: package-lock\.json/);
  } finally { lockChanged.cleanup(); }

  const removed = repo();
  try {
    rmSync(join(removed.root, "src/web-main.ts"));
    assert.throws(() => createCanonicalCandidatePatch(removed.root, removed.baseSha, removed.candidate), /not changed in the validation worktree: src\/web-main\.ts/);
  } finally { removed.cleanup(); }

  const reverted = repo();
  try {
    write(reverted.root, "package.json", '{"name":"app"}\n'); // base 내용으로 되돌아감
    assert.throws(() => createCanonicalCandidatePatch(reverted.root, reverted.baseSha, reverted.candidate), /not changed in the validation worktree: package\.json/);
  } finally { reverted.cleanup(); }
});

test("exact base가 아니거나 candidate 경로가 stage된 worktree는 거부한다", () => {
  const f = repo();
  try {
    assert.throws(() => createCanonicalCandidatePatch(f.root, "0".repeat(40), f.candidate), /not the exact base SHA/);
    run(f.root, "add", "package.json");
    assert.throws(() => createCanonicalCandidatePatch(f.root, f.baseSha, f.candidate), /candidate path has an unexpected git status "M ": package\.json/);
  } finally { f.cleanup(); }
});

test("status 파싱/분류 pure 규칙", () => {
  const entries = parsePorcelainStatus(" M package.json\0?? src/web-main.ts\0?? dist/index.html\0R  new.md\0old.md\0");
  assert.deepEqual(entries, [
    { status: " M", path: "package.json" },
    { status: "??", path: "src/web-main.ts" },
    { status: "??", path: "dist/index.html" },
    { status: "R ", path: "new.md" },
  ]);
  assert.deepEqual(parsePorcelainStatus(""), []);
  assert.throws(() => parsePorcelainStatus("bad\0"), /unexpected git status entry/);

  assert.deepEqual(
    classifyValidationWorktree(entries.slice(0, 3), ["src/web-main.ts", "package.json"]),
    { candidatePaths: ["package.json", "src/web-main.ts"], excludedUntrackedPaths: ["dist/index.html"] },
  );
  assert.throws(() => classifyValidationWorktree(entries, ["src/web-main.ts", "package.json"]), /outside the candidate: R:new\.md/);
  assert.throws(() => classifyValidationWorktree(entries.slice(0, 1), ["package.json", "src/web-main.ts"]), /not changed in the validation worktree: src\/web-main\.ts/);
  assert.throws(() => classifyValidationWorktree([], []), /at least one path/);
  assert.throws(() => classifyValidationWorktree(entries.slice(0, 1), ["package.json", "package.json"]), /must be unique/);
  // untracked라도 candidate 경로와 이름이 같으면 제외 대상이 아니라 candidate 파일이다.
  assert.deepEqual([...classifyValidationWorktree([{ status: "??", path: "dist/index.html" }], ["dist/index.html"]).excludedUntrackedPaths], []);
});

test("finalize는 candidate의 exact path + content로 canonical patch를 만들고, 나머지 provenance 경계는 그대로다", () => {
  const finalize = handlerSource.split("async function finalize(): Promise<void> {")[1] ?? "";
  assert.match(finalize, /createCanonicalCandidatePatch\(\s*targetDirectory,\s*observedBaseSha,\s*live\.candidate\.changes\.map\(\(\{ path, content \}\) => \(\{ path, content \}\)\),\s*\)/);
  // exact-base / live 재검증 / digest 결합은 그대로
  assert.match(finalize, /const live = await validateAllLiveInputs\(/);
  assert.match(finalize, /observedBaseSha !== live\.bundle\.contract\.baseSha/);
  assert.match(finalize, /verifyDeterministicValidationResult\(validation\);/);
  assert.match(finalize, /createPlanCandidateBridgeProvenance\(\{/);
  assert.match(finalize, /candidatePatch: patch,/);
  assert.match(finalize, /verifyPlanCandidateBridgeProvenance\(provenance\);/);
  assert.match(finalize, /validateBridgePatch\(provenance, patch\);/);
  // 제외된 artifact는 provenance/출력 파일에 들어가지 않는다 (log만).
  assert.doesNotMatch(bridgeSource, /excludedUntrackedPaths/);
  assert.equal((finalize.match(/writeFileSync\(/g) ?? []).length, 2);
  // 옛 계약 제거
  assert.doesNotMatch(handlerSource, /validation worktree paths mismatch/);
});

test("#176 recovery: 성공한 Worker candidate를 AI 재호출 없이 기존 Bridge recovery 경로로 재사용할 수 있다", () => {
  // 실제 cycle: Handoff(PLAN-재개, issue_comment) base = Worker head = 922a670…, Worker run 35516002653 success.
  // 이 수정이 merge되면 default branch만 이동한다. 그 drift는 이 PR의 파일들이다.
  const thisChange = [
    "src/self-improvement/plan-bridge-patch.ts",
    "src/self-improvement/plan-candidate-bridge-handler.ts",
    "test/plan-candidate-bridge-recovery-finalize.test.ts",
  ];
  const drift = classifyDrift(
    thisChange.map((path, index) => ({ path, status: index === 0 ? "added" as const : "modified" as const })),
    BRIDGE_RECOVERY_DRIFT_POLICY,
  );
  assert.equal(drift.class, "FRAMEWORK_ONLY", JSON.stringify(drift.rejections));

  // 같은 판정을 실제 Bridge workflow의 recovery guard 리터럴로도 확인한다.
  const workflow = readFileSync(".github/workflows/plan-candidate-bridge.yml", "utf8");
  assert.ok(workflow.includes("path.startsWith('src/self-improvement/')"));
  assert.ok(workflow.includes("'test/plan-candidate-bridge-recovery-finalize.test.ts',"));
  assert.match(workflow, /files\.length > 50/);

  // recovery 진입점과 source 검증은 그대로: 명시적 Worker run + exact artifact, rebind Handoff(issue_comment) 허용, AI 없음.
  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      source_worker_run_id:/);
  assert.match(workflow, /source_worker_run_attempt:/);
  assert.match(workflow, /source_candidate_artifact_name:/);
  assert.match(workflow, /!\['workflow_run', 'issue_comment'\]\.includes\(handoff\.event\)/);
  assert.match(workflow, /const recovery = explicitRecovery \|\| run\.head_sha !== approvedBaseSha/);
  assert.match(workflow, /core\.setOutput\('bridge_control_plane_sha', recovery \? context\.sha : run\.head_sha\)/);
  assert.doesNotMatch(workflow, /openai\/codex-action|APP_CODEX_API_KEY/);
  const artifact = "bounded-worker-candidate-issue-176-plan-35514067988-approval-5750163355-handoff-35515986038-attempt-1-worker-35516002653-attempt-1";
  assert.match(artifact, new RegExp("^bounded-worker-candidate-issue-\\d+-plan-\\d+-approval-\\d+-handoff-(\\d+)-attempt-(\\d+)-worker-35516002653-attempt-1$"));

  // recovery guard: candidate base는 그대로, trusted code만 새 default SHA.
  const base = "922a670fa968" + "0".repeat(28);
  const newDefault = "a".repeat(40);
  assert.doesNotThrow(() => validateBridgeTrustedCodeIdentity({
    baseSha: base,
    trustedCodeSha: newDefault,
    recoveryGuard: { kind: "trusted-recovery-compare-v1", baseSha: base, workerHeadSha: base, currentDefaultSha: newDefault },
  }));
  assert.throws(() => validateBridgeTrustedCodeIdentity({ baseSha: base, trustedCodeSha: newDefault }), /must equal exact candidate base SHA/);

  // Trusted Rail은 Bridge run이 current default에서 실행되면 drift 비교 없이 받는다 (경계 변경 없음).
  const rail = readFileSync(".github/workflows/trusted-rail.yml", "utf8");
  assert.match(rail, /sourceKind === 'PLAN_BRIDGE' && run\.head_sha !== currentDefaultSha/);
  assert.match(rail, /new Set\(\['workflow_run', 'workflow_dispatch'\]\)/);
});
