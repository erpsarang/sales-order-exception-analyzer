import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const trustedRail = readFileSync(".github/workflows/trusted-rail.yml", "utf8");

test("Trusted Rail은 PLAN_BRIDGE에 한해 automatic과 recovery event를 허용한다", () => {
  assert.match(
    trustedRail,
    /const expectedEvents = sourceKind === 'PLAN_BRIDGE'[\s\S]{0,160}new Set\(\['workflow_run', 'workflow_dispatch'\]\)[\s\S]{0,80}new Set\(\['workflow_dispatch'\]\)/,
  );
  assert.match(trustedRail, /!expectedEvents\.has\(run\.event\)/);
});

test("recovery PLAN_BRIDGE는 exact source identity와 artifact 단일성을 유지한다", () => {
  assert.match(trustedRail, /run\.path !== expectedPath/);
  assert.match(trustedRail, /run\.head_branch !== defaultBranch/);
  assert.match(trustedRail, /run\.run_attempt !== runAttempt/);
  assert.match(trustedRail, /exact\.length !== 1 \|\| matches\.length !== 1/);
  assert.match(trustedRail, /unexpected explicit \$\{sourceKind\} candidate artifact/);
});

test("PLAN_BRIDGE recovery만 bounded framework-only ancestor drift를 허용한다", () => {
  assert.match(trustedRail, /Trusted Rail recovery code is not exact current default branch/);
  assert.match(trustedRail, /context\.sha !== currentDefaultSha/);
  assert.match(trustedRail, /sourceKind === 'PLAN_BRIDGE' && run\.head_sha !== currentDefaultSha/);
  assert.match(trustedRail, /compareCommitsWithBasehead/);
  assert.match(trustedRail, /comparison\.merge_base_commit\.sha !== run\.head_sha/);
  assert.match(trustedRail, /files\.length > 8/);
  assert.match(trustedRail, /'\.github\/workflows\/trusted-rail\.yml'/);
  assert.match(trustedRail, /'\.github\/workflows\/semantic-review\.yml'/);
  assert.match(trustedRail, /'test\/plan-trusted-rail-recovery-source\.test\.ts'/);
  assert.match(trustedRail, /'test\/review-workflow\.test\.ts'/);
  assert.match(trustedRail, /!\['added', 'modified'\]\.includes\(file\.status\)/);
  assert.match(trustedRail, /PLAN_BRIDGE recovery requires fresh PLAN; non-approved drift/);
});

test("FIX recovery는 current default SHA exact match를 계속 요구한다", () => {
  assert.match(trustedRail, /sourceKind === 'FIX' && run\.head_sha !== currentDefaultSha/);
  assert.match(trustedRail, /FIX recovery requires exact current default SHA/);
});
