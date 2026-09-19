import assert from "node:assert/strict";
import test from "node:test";
import { createAppRuntimeEvidence, verifyAppRuntimeEvidence } from "../src/app-evidence.js";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { analyzeOrder, type ExceptionGuide, type ReasonCode } from "../src/order-analysis.js";

const sha = "a".repeat(40);
const purpose = "주문 데이터를 받아 출고 가능/예외를 판정하고 사유코드 반환";

const expectedGuides: Record<ReasonCode, ExceptionGuide> = {
  INVALID_QUANTITY: {
    reasonCode: "INVALID_QUANTITY",
    check: "주문수량과 입력 단위 확인",
    action: "수량을 양수로 정정 후 재분석",
  },
  CUSTOMER_BLOCKED: {
    reasonCode: "CUSTOMER_BLOCKED",
    check: "고객 차단 사유와 해제 요건 확인",
    action: "해제 가능 여부 확인 후 주문 재분석",
  },
  MATERIAL_BLOCKED: {
    reasonCode: "MATERIAL_BLOCKED",
    check: "자재 차단 사유와 해제 요건 확인",
    action: "해제 가능 여부 확인 후 주문 재분석",
  },
  INSUFFICIENT_STOCK: {
    reasonCode: "INSUFFICIENT_STOCK",
    check: "가용재고와 부족 수량 확인",
    action: "재고 확보 또는 주문수량 조정 후 재분석",
  },
};

test("App Runtime Evidence는 실제 app 실행 결과를 deterministic하게 담는다", () => {
  const first = createAppRuntimeEvidence(sha, purpose);
  const second = createAppRuntimeEvidence(sha, purpose);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  verifyAppRuntimeEvidence(first, sha);
  assert.equal(first.scenarios.length, 4);
  assert.deepEqual(first.scenarios.map(({ id, description, input }) => ({
    id, description, orderCount: input.orderCount, orderIds: input.orderIds,
  })), [
    {
      id: "all-ready", description: "모든 주문이 출고 가능한 batch",
      orderCount: 2, orderIds: ["SO-READY-1", "SO-READY-2"],
    },
    {
      id: "mixed-exceptions", description: "정상 주문과 서로 다른 예외 사유가 함께 있는 batch",
      orderCount: 4, orderIds: ["SO-READY-1", "SO-INVALID", "SO-CUSTOMER", "SO-STOCK"],
    },
    {
      id: "multiple-reasons", description: "한 주문에 여러 예외 사유가 동시에 있는 batch",
      orderCount: 1, orderIds: ["SO-MULTI"],
    },
    {
      id: "duplicate-exception-id", description: "동일 주문 ID의 예외 입력이 반복되는 batch",
      orderCount: 2, orderIds: ["SO-DUP", "SO-DUP"],
    },
  ]);

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
  });
  assert.deepEqual(mixed.output.results[0]!.orderDetails, {
    materialId: "M-001",
    orderQuantity: 10,
    customerId: "C-001",
    estimatedAmount: 1250000,
    dueDate: "2026-10-15",
    orderComment: "오전 입고 요청",
  });
  const seenReasons = new Set<ReasonCode>();
  for (const scenario of first.scenarios) {
    assert.deepEqual(scenario.output, analyzeOrderBatch(scenario.input.orders));
    assert.equal(scenario.input.orderCount, scenario.input.orders.length);
    assert.deepEqual(scenario.input.orderIds, scenario.input.orders.map(({ orderId }) => orderId));
    assert.equal(scenario.output.results.length, scenario.input.orders.length);
    scenario.input.orders.forEach((order, index) => {
      const result = scenario.output.results[index]!;
      const hasDetails = scenario.id === "duplicate-exception-id" ||
        (scenario.id === "mixed-exceptions" && index === 0);
      for (const key of ["estimatedAmount", "dueDate", "orderComment"] as const) {
        assert.equal(Object.prototype.hasOwnProperty.call(order, key), hasDetails);
        assert.equal(Object.prototype.hasOwnProperty.call(result.orderDetails, key), hasDetails);
      }
      const { orderId, availableQuantity, customerBlocked, materialBlocked, ...orderDetails } = order;
      assert.equal(result.orderId, orderId);
      assert.deepEqual(result.orderDetails, orderDetails);
      assert.notStrictEqual(result.orderDetails, order);
      const { orderId: resultId, orderDetails: resultDetails, ...analysis } = result;
      assert.deepEqual(analysis, analyzeOrder(order));
      assert.deepEqual(result.exceptionGuides, result.reasonCodes.map((code) => expectedGuides[code]));
      for (const code of result.reasonCodes) seenReasons.add(code);
    });
  }
  assert.deepEqual([...seenReasons].sort(), Object.keys(expectedGuides).sort());

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

test("App Runtime Evidence는 가이드 변조 및 생략과 실제 출력 변조를 거부한다", () => {
  const mutations: Array<(evidence: ReturnType<typeof createAppRuntimeEvidence>) => void> = [
    (evidence) => { evidence.scenarios[1]!.output.results[1]!.exceptionGuides[0]!.check = "변조"; },
    (evidence) => { evidence.scenarios[1]!.output.results[1]!.exceptionGuides[0]!.action = "변조"; },
    (evidence) => { evidence.scenarios[1]!.output.results[1]!.exceptionGuides[0]!.reasonCode = "MATERIAL_BLOCKED"; },
    (evidence) => { evidence.scenarios[1]!.output.results[1]!.exceptionGuides.length = 0; },
    (evidence) => { evidence.scenarios[2]!.output.results[0]!.exceptionGuides.reverse(); },
    (evidence) => { evidence.scenarios[1]!.output.results[1]!.reasonCodes.length = 0; },
    (evidence) => { evidence.scenarios[1]!.output.summary.exceptionCount = 0; },
    (evidence) => { evidence.scenarios[3]!.output.exceptionPriorities[0]!.rank = 99; },
    (evidence) => { evidence.scenarios[1]!.output.results[0]!.orderDetails.orderComment = "변조"; },
  ];
  for (const mutate of mutations) {
    const evidence = createAppRuntimeEvidence(sha, purpose);
    mutate(evidence);
    assert.throws(() => verifyAppRuntimeEvidence(evidence, sha), /does not match deterministic app execution/);
  }
  const first = createAppRuntimeEvidence(sha, purpose);
  const second = createAppRuntimeEvidence(sha, purpose);
  first.scenarios[1]!.output.results[1]!.exceptionGuides[0]!.check = "변조";
  assert.deepEqual(createAppRuntimeEvidence(sha, purpose), second);
  verifyAppRuntimeEvidence(second, sha);
});

test("App Runtime Evidence는 UTF-8 8192 bytes까지 허용하고 초과를 거부한다", () => {
  const baseBytes = Buffer.byteLength(JSON.stringify(createAppRuntimeEvidence(sha, purpose)), "utf8");
  const remaining = 8_192 - baseBytes;
  assert.ok(remaining >= 3);
  const boundaryPurpose = purpose + "가".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
  const boundary = createAppRuntimeEvidence(sha, boundaryPurpose);
  assert.equal(Buffer.byteLength(JSON.stringify(boundary), "utf8"), 8_192);
  assert.ok(JSON.stringify(boundary).length < 8_192);
  verifyAppRuntimeEvidence(boundary, sha);

  const over = createAppRuntimeEvidence(sha, boundaryPurpose + "x");
  assert.equal(Buffer.byteLength(JSON.stringify(over), "utf8"), 8_193);
  assert.ok(JSON.stringify(over).length < 8_192);
  assert.throws(() => verifyAppRuntimeEvidence(over, sha), /exceeds bounded evidence item budget/);

  over.scenarios[1]!.output.results[1]!.exceptionGuides[0]!.check = "변조";
  assert.throws(() => verifyAppRuntimeEvidence(over, sha), /does not match deterministic app execution/);
  assert.throws(() => verifyAppRuntimeEvidence(over, "b".repeat(40)), /invalid App Runtime Evidence identity/);
});
