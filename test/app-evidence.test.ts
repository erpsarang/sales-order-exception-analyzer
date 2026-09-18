import assert from "node:assert/strict";
import test from "node:test";
import { createAppRuntimeEvidence, verifyAppRuntimeEvidence } from "../src/app-evidence.js";

const sha = "a".repeat(40);
const purpose = "주문 데이터를 받아 출고 가능/예외를 판정하고 사유코드 반환";

test("App Runtime Evidence는 실제 app 실행 결과를 deterministic하게 담는다", () => {
  const first = createAppRuntimeEvidence(sha, purpose);
  const second = createAppRuntimeEvidence(sha, purpose);

  assert.deepEqual(first, second);
  verifyAppRuntimeEvidence(first, sha);
  assert.equal(first.scenarios.length, 4);

  const mixed = first.scenarios.find(({ id }) => id === "mixed-exceptions")!;
  assert.deepEqual(mixed.output.summary.exceptionOrderIds, [
    "SO-INVALID",
    "SO-CUSTOMER",
    "SO-STOCK",
  ]);
  assert.equal(mixed.output.summary.exceptionCount, 3);
  assert.equal(mixed.output.summary.shipReadyCount, 1);

  const duplicate = first.scenarios.find(({ id }) => id === "duplicate-exception-id")!;
  assert.deepEqual(duplicate.output.summary.exceptionOrderIds, ["SO-DUP", "SO-DUP"]);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= 8_192);
});

test("App Runtime Evidence는 source SHA 변조를 거부한다", () => {
  const evidence = createAppRuntimeEvidence(sha, purpose);
  assert.throws(() => verifyAppRuntimeEvidence(evidence, "b".repeat(40)));
});
