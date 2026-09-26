import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFulfillmentRisk } from "../src/fulfillment-risk.js";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { analyzeOrder, type OrderInput } from "../src/order-analysis.js";

function order(overrides: Partial<OrderInput> = {}): OrderInput {
  return {
    orderId: "SO-1", customerId: "C-1", materialId: "M-1",
    orderQuantity: 4, availableQuantity: 10,
    customerBlocked: false, materialBlocked: false,
    dueDate: "2026-10-01", ...overrides,
  };
}

test("납기 순 차감과 최초 및 누적 부족을 수치로 반환한다", () => {
  const result = analyzeFulfillmentRisk([
    order({ orderId: "late", dueDate: "2026-10-03", orderQuantity: 2 }),
    order({ orderId: "early", orderQuantity: 6 }),
    order({ orderId: "middle", dueDate: "2026-10-02", orderQuantity: 7 }),
  ]);
  assert.deepEqual(result, [{
    materialId: "M-1", status: "complete", initialStock: 10,
    calculationIssues: [], excludedOrders: [],
    steps: [
      { inputIndex: 1, orderId: "early", dueDate: "2026-10-01", orderQuantity: 6, remainingBefore: 10, remainingAfter: 4, shortageQuantity: 0, cumulativeShortageQuantity: 0 },
      { inputIndex: 2, orderId: "middle", dueDate: "2026-10-02", orderQuantity: 7, remainingBefore: 4, remainingAfter: 0, shortageQuantity: 3, cumulativeShortageQuantity: 3 },
      { inputIndex: 0, orderId: "late", dueDate: "2026-10-03", orderQuantity: 2, remainingBefore: 0, remainingAfter: 0, shortageQuantity: 2, cumulativeShortageQuantity: 5 },
    ],
    firstShortage: { inputIndex: 2, orderId: "middle", dueDate: "2026-10-02", shortageQuantity: 3 },
  }]);
});

test("동일 납기는 입력 순서를 보존하고 차단·금액·중복 ID는 차감을 바꾸지 않는다", () => {
  const shared = Object.freeze(order({ customerBlocked: true, materialBlocked: true, estimatedAmount: 1 }));
  const orders = Object.freeze([
    shared, Object.freeze(order({ estimatedAmount: 999 })), shared,
  ]);
  const snapshot = orders.map((entry) => ({ ...entry }));
  const result = analyzeFulfillmentRisk(orders)[0]!;
  assert.deepEqual(result.steps.map((step) => step.inputIndex), [0, 1, 2]);
  assert.deepEqual(result.steps.map((step) => step.remainingAfter), [6, 2, 0]);
  assert.deepEqual(result.firstShortage, {
    inputIndex: 2, orderId: "SO-1", dueDate: "2026-10-01", shortageQuantity: 2,
  });
  assert.deepEqual(result.excludedOrders, []);
  assert.deepEqual(orders, snapshot);
});

test("자재는 정확한 ID로 격리하고 첫 등장 순서로 반환한다", () => {
  const result = analyzeFulfillmentRisk([
    order({ materialId: "__proto__", dueDate: "2026-10-03" }),
    order({ materialId: "m", availableQuantity: 0 }),
    order({ materialId: "M", availableQuantity: 20 }),
    order({ materialId: "__proto__", orderQuantity: 8 }),
    order({ materialId: "m ", availableQuantity: 4 }),
  ]);
  assert.deepEqual(result.map((entry) => entry.materialId), ["__proto__", "m", "M", "m "]);
  assert.deepEqual(result.map((entry) => entry.initialStock), [10, 0, 20, 4]);
  assert.deepEqual(result.map((entry) => entry.steps.map((step) => step.remainingAfter)), [[2, 0], [0], [16], [0]]);
  assert.deepEqual(result.map((entry) => entry.firstShortage?.inputIndex ?? null), [0, 1, null, null]);
});

test("빈 입력, 정확한 소진, 재고 0과 소수 수량을 구분한다", () => {
  assert.deepEqual(analyzeFulfillmentRisk([]), []);
  const exact = analyzeFulfillmentRisk([order({ orderQuantity: 10 })])[0]!;
  assert.equal(exact.status, "complete");
  assert.equal(exact.steps[0]!.remainingAfter, 0);
  assert.equal(exact.firstShortage, null);
  for (const availableQuantity of [0, -0]) {
    const result = analyzeFulfillmentRisk([order({ availableQuantity })])[0]!;
    assert.equal(result.initialStock, 0);
    assert.equal(result.firstShortage!.shortageQuantity, 4);
  }
  const fractions = analyzeFulfillmentRisk([
    order({ availableQuantity: 0.75, orderQuantity: 0.5 }),
    order({ availableQuantity: 0.75, orderQuantity: 0.5 }),
  ])[0]!;
  assert.deepEqual(fractions.steps.map((step) => step.remainingAfter), [0.25, 0]);
  assert.equal(fractions.firstShortage!.shortageQuantity, 0.25);
  for (const quantity of [Number.MIN_VALUE, Number.MAX_VALUE]) {
    const result = analyzeFulfillmentRisk([order({ availableQuantity: quantity, orderQuantity: quantity })])[0]!;
    assert.equal(result.status, "complete");
    assert.equal(result.firstShortage, null);
    assert.equal(result.steps[0]!.remainingAfter, 0);
  }
});

test("유한한 개별 수량의 누적 부족이 number 범위를 넘는 경우를 명시한다", () => {
  const result = analyzeFulfillmentRisk([
    order({ availableQuantity: 0, orderQuantity: Number.MAX_VALUE }),
    order({ availableQuantity: 0, orderQuantity: Number.MAX_VALUE }),
  ])[0]!;
  assert.equal(result.steps[0]!.cumulativeShortageQuantity, Number.MAX_VALUE);
  assert.equal(result.steps[1]!.cumulativeShortageQuantity, Infinity);
  assert.equal(result.firstShortage!.inputIndex, 0);
});

test("실제 날짜와 연도 경계를 검증하고 모든 무효 납기를 제외한다", () => {
  const valid = ["0001-01-01", "0096-02-29", "0400-02-29", "2000-02-29", "2024-02-29", "2026-04-30", "9999-12-31"];
  const invalid: unknown[] = [
    undefined, null, 20261001, false, "", "미정", "0000-01-01", "10000-01-01",
    "0100-02-29", "1900-02-29", "2100-02-29", "2026-02-29", "2024-02-30",
    "2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31", "2026-01-32",
    "2026-00-01", "2026-13-01", "2026-01-00", "2026-1-01", "2026-01-1",
    " 2026-01-01", "2026-01-01 ", "2026-01-01\n", "2026/01/01", "2026-01-01T00:00:00Z",
  ];
  for (const dueDate of valid) {
    const result = analyzeFulfillmentRisk([order({ dueDate })])[0]!;
    assert.equal(result.status, "complete");
    assert.equal(result.steps[0]!.dueDate, dueDate);
  }
  for (const dueDate of invalid) {
    const input = { ...order(), dueDate } as unknown as OrderInput;
    const result = analyzeFulfillmentRisk([input])[0]!;
    assert.equal(result.status, "partial");
    assert.equal(result.initialStock, 10);
    assert.deepEqual(result.calculationIssues, ["NO_ELIGIBLE_ORDERS"]);
    assert.deepEqual(result.steps, []);
    assert.equal(result.firstShortage, null);
    assert.deepEqual(result.excludedOrders, [{ inputIndex: 0, orderId: "SO-1", reasons: ["INVALID_DUE_DATE"] }]);
  }
  const sorted = analyzeFulfillmentRisk([...valid].reverse().map((dueDate) => order({ dueDate })))[0]!;
  assert.deepEqual(sorted.steps.map((step) => step.dueDate), valid);
});

test("무효 주문수량은 제외하고 복수 제외 사유와 부분 계산을 반환한다", () => {
  const invalid: unknown[] = [undefined, null, 0, -0, -1, NaN, Infinity, -Infinity, "4", false];
  for (const orderQuantity of invalid) {
    const input = { ...order(), orderQuantity } as unknown as OrderInput;
    const result = analyzeFulfillmentRisk([input, order({ orderQuantity: 11 })])[0]!;
    assert.equal(result.status, "partial");
    assert.deepEqual(result.calculationIssues, []);
    assert.deepEqual(result.excludedOrders, [{ inputIndex: 0, orderId: "SO-1", reasons: ["INVALID_ORDER_QUANTITY"] }]);
    assert.equal(result.steps[0]!.remainingBefore, 10);
    assert.deepEqual(result.firstShortage, { inputIndex: 1, orderId: "SO-1", dueDate: "2026-10-01", shortageQuantity: 1 });
  }
  const result = analyzeFulfillmentRisk([order({ dueDate: "미정", orderQuantity: 0 }), order()])[0]!;
  assert.equal(result.status, "partial");
  assert.equal(result.firstShortage, null);
  assert.deepEqual(result.excludedOrders[0]!.reasons, ["INVALID_DUE_DATE", "INVALID_ORDER_QUANTITY"]);
  assert.equal(result.steps[0]!.remainingAfter, 6);
});

test("모든 입력의 재고가 유효하고 동일해야 계산하며 제외 주문의 재고도 검사한다", () => {
  const invalid: unknown[] = [undefined, null, -1, NaN, Infinity, -Infinity, "10", false];
  for (const availableQuantity of invalid) {
    const input = { ...order(), availableQuantity, dueDate: "미정" } as unknown as OrderInput;
    for (const orders of [[input, order()], [order(), input]]) {
      const result = analyzeFulfillmentRisk(orders)[0]!;
      assert.equal(result.status, "unavailable");
      assert.equal(result.initialStock, null);
      assert.deepEqual(result.calculationIssues, ["INVALID_AVAILABLE_QUANTITY"]);
      assert.equal(result.excludedOrders.length, 1);
      assert.deepEqual(result.steps, []);
      assert.equal(result.firstShortage, null);
    }
  }
  for (const orders of [
    [order(), order({ availableQuantity: 20, dueDate: "미정" })],
    [order({ availableQuantity: 20 }), order()],
  ]) {
    const result = analyzeFulfillmentRisk(orders)[0]!;
    assert.equal(result.status, "unavailable");
    assert.equal(result.initialStock, null);
    assert.deepEqual(result.calculationIssues, ["INCONSISTENT_AVAILABLE_QUANTITY"]);
    assert.deepEqual(result.steps, []);
  }
  const combined = analyzeFulfillmentRisk([
    order({ availableQuantity: NaN, dueDate: "" }),
    order({ availableQuantity: 1, dueDate: "" }),
    order({ availableQuantity: 2, dueDate: "" }),
    order({ materialId: "healthy" }),
  ]);
  assert.deepEqual(combined[0]!.calculationIssues, ["INVALID_AVAILABLE_QUANTITY", "INCONSISTENT_AVAILABLE_QUANTITY", "NO_ELIGIBLE_ORDERS"]);
  assert.equal(combined[1]!.status, "complete");
  assert.equal(combined[1]!.steps[0]!.remainingAfter, 6);
});

test("입력과 출력 및 호출 사이에 가변 객체를 공유하지 않는다", () => {
  const shared = Object.freeze(order({ orderQuantity: 6 }));
  const orders = Object.freeze([shared, shared, Object.freeze(order({ dueDate: "" }))]);
  const snapshot = orders.map((entry) => ({ ...entry }));
  const first = analyzeFulfillmentRisk(orders);
  const second = analyzeFulfillmentRisk(orders);
  const expected = structuredClone(second);
  assert.deepEqual(first, second);
  first[0]!.firstShortage!.orderId = "changed";
  assert.equal(first[0]!.steps[1]!.orderId, "SO-1");
  first[0]!.steps[0]!.remainingAfter = 999;
  first[0]!.steps.reverse();
  first[0]!.excludedOrders[0]!.reasons.length = 0;
  first[0]!.calculationIssues.push("NO_ELIGIBLE_ORDERS");
  first[0]!.initialStock = 999;
  first.length = 0;
  assert.deepEqual(second, expected);
  assert.deepEqual(analyzeFulfillmentRisk(orders), expected);
  assert.deepEqual(orders, snapshot);
  const empty = analyzeFulfillmentRisk([]);
  assert.notStrictEqual(empty, analyzeFulfillmentRisk([]));
  const mutable = order();
  const result = analyzeFulfillmentRisk([mutable]);
  mutable.orderId = "changed";
  mutable.orderQuantity = 999;
  assert.equal(result[0]!.steps[0]!.orderId, "SO-1");
  assert.equal(result[0]!.steps[0]!.orderQuantity, 4);
});

test("독립 공급 위험 분석은 기존 Batch 판정·집계·우선순위·작업목록을 보존한다", () => {
  const orders = Object.freeze([
    Object.freeze(order({ orderQuantity: 6, dueDate: "2026-10-03" })),
    Object.freeze(order({ orderQuantity: 6, dueDate: "2026-10-02" })),
    Object.freeze(order({ customerBlocked: true, materialBlocked: true, dueDate: "2026-10-01" })),
    Object.freeze(order({ orderQuantity: 0, dueDate: "미정" })),
  ]);
  const before = analyzeOrderBatch(orders);
  const snapshot = structuredClone(before);
  const risk = analyzeFulfillmentRisk(orders)[0]!;
  assert.equal(risk.status, "partial");
  assert.equal(risk.firstShortage!.inputIndex, 0);
  assert.equal(risk.firstShortage!.shortageQuantity, 6);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(analyzeOrderBatch(orders), snapshot);
  assert.deepEqual(Object.keys(before).sort(), ["exceptionPriorities", "exceptionWorklist", "results", "summary"]);
  assert.deepEqual(before.results.map((entry) => entry.reasonCodes), [[], [], ["CUSTOMER_BLOCKED", "MATERIAL_BLOCKED"], ["INVALID_QUANTITY"]]);
  assert.deepEqual(before.summary, {
    totalCount: 4, shipReadyCount: 2, exceptionCount: 2, exceptionRate: 0.5,
    exceptionOrderIds: ["SO-1", "SO-1"],
    reasonCounts: { INVALID_QUANTITY: 1, CUSTOMER_BLOCKED: 1, MATERIAL_BLOCKED: 1, INSUFFICIENT_STOCK: 0 },
    topReasonCodes: ["INVALID_QUANTITY", "CUSTOMER_BLOCKED", "MATERIAL_BLOCKED"],
  });
  assert.deepEqual(before.exceptionPriorities.map((entry) => entry.resultIndex), [2, 3]);
  assert.deepEqual(before.exceptionWorklist.map((entry) => entry.resultIndex), [2, 3]);
  orders.forEach((input, index) => {
    const { orderId, orderDetails, ...analysis } = before.results[index]!;
    assert.equal(orderId, input.orderId);
    assert.equal(orderDetails.dueDate, input.dueDate);
    assert.deepEqual(analysis, analyzeOrder(input));
  });
});
