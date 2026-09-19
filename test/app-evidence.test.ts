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

  assert.equal(mixed.input.orders.length, mixed.input.orderCount);
  assert.deepEqual(
    Object.keys(mixed.input.orders[0]!).sort(),
    [
      "availableQuantity",
      "customerBlocked",
      "customerId",
      "dueDate",
      "estimatedAmount",
      "materialBlocked",
      "materialId",
      "orderComment",
      "orderId",
      "orderQuantity",
    ],
  );
  assert.deepEqual(mixed.input.orders[1], {
    orderId: "SO-INVALID",
    customerId: "C-001",
    materialId: "M-001",
    orderQuantity: 0,
    availableQuantity: 20,
    customerBlocked: false,
    materialBlocked: false,
    estimatedAmount: 1250000,
    dueDate: "2026-10-15",
    orderComment: "오전 입고 요청",
  });
  assert.deepEqual(mixed.output.results[0]!.orderDetails, {
    materialId: "M-001",
    orderQuantity: 10,
    customerId: "C-001",
    estimatedAmount: 1250000,
    dueDate: "2026-10-15",
    orderComment: "오전 입고 요청",
  });
  for (const scenario of first.scenarios) {
    assert.equal(scenario.output.results.length, scenario.input.orders.length);
    scenario.input.orders.forEach((order, index) => {
      const result = scenario.output.results[index]!;
      assert.equal(result.orderId, order.orderId);
      assert.deepEqual(result.orderDetails, {
        materialId: order.materialId,
        orderQuantity: order.orderQuantity,
        customerId: order.customerId,
        estimatedAmount: order.estimatedAmount,
        dueDate: order.dueDate,
        orderComment: order.orderComment,
      });
      assert.notStrictEqual(result.orderDetails, order);
    });
  }

  const duplicate = first.scenarios.find(({ id }) => id === "duplicate-exception-id")!;
  assert.deepEqual(duplicate.output.summary.exceptionOrderIds, ["SO-DUP", "SO-DUP"]);
  assert.deepEqual(duplicate.output.results.map(({ orderDetails }) => orderDetails), [
    {
      materialId: "M-001",
      orderQuantity: 10,
      customerId: "C-001",
      estimatedAmount: 1250000,
      dueDate: "2026-10-15",
      orderComment: "오전 입고 요청",
    },
    {
      materialId: "M-002",
      orderQuantity: 5,
      customerId: "C-002",
      estimatedAmount: 625000,
      dueDate: "2026-10-16",
      orderComment: "오후 입고 요청",
    },
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= 8_192);
});

test("App Runtime Evidence는 source SHA 변조를 거부한다", () => {
  const evidence = createAppRuntimeEvidence(sha, purpose);
  assert.throws(() => verifyAppRuntimeEvidence(evidence, "b".repeat(40)));
});
