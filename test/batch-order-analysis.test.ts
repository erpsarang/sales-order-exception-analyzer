import assert from "node:assert/strict";
import test from "node:test";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { analyzeOrder, type OrderInput } from "../src/order-analysis.js";

const normalOrder: Readonly<OrderInput> = Object.freeze({
  orderId: "SO-003",
  customerId: "C-001",
  materialId: "M-001",
  orderQuantity: 10,
  availableQuantity: 20,
  customerBlocked: false,
  materialBlocked: false,
});
const exceptionOrder: Readonly<OrderInput> = Object.freeze({
  ...normalOrder,
  orderId: "SO-001",
  orderQuantity: 0,
  availableQuantity: -1,
  customerBlocked: true,
  materialBlocked: true,
});

type ReasonCode = ReturnType<typeof analyzeOrder>["reasonCodes"][number];
const reasonCodeOrder: readonly ReasonCode[] = [
  "INVALID_QUANTITY",
  "CUSTOMER_BLOCKED",
  "MATERIAL_BLOCKED",
  "INSUFFICIENT_STOCK",
];
const zeroReasonCounts = (): Record<ReasonCode, number> => ({
  INVALID_QUANTITY: 0,
  CUSTOMER_BLOCKED: 0,
  MATERIAL_BLOCKED: 0,
  INSUFFICIENT_STOCK: 0,
});

const cases = [
  { name: "정상 주문만", orders: [normalOrder, { ...normalOrder, availableQuantity: 10 }], ready: 2, exceptions: 0 },
  { name: "예외 주문만", orders: [exceptionOrder, { ...normalOrder, availableQuantity: 0 }], ready: 0, exceptions: 2 },
  { name: "정상 및 예외 주문 혼합", orders: [normalOrder, exceptionOrder, { ...normalOrder, orderId: "SO-002" }], ready: 2, exceptions: 1 },
  { name: "빈 배열", orders: [], ready: 0, exceptions: 0 },
];

for (const { name, orders, ready, exceptions } of cases) {
  test(`${name}: 단일 주문과 동일한 판정 및 정확한 집계를 반환한다`, () => {
    const { results, summary } = analyzeOrderBatch(orders);
    const expectedResults = orders.map((order) => ({
      orderId: order.orderId,
      ...analyzeOrder(order),
    }));
    assert.deepEqual(results, expectedResults);
    const reasonCounts = zeroReasonCounts();
    for (const code of reasonCodeOrder) {
      reasonCounts[code] = expectedResults.filter((result) =>
        result.status === "EXCEPTION" && result.reasonCodes.includes(code),
      ).length;
    }
    const topReasonCodes = reasonCodeOrder.filter((code) =>
      reasonCounts[code] > 0 && reasonCodeOrder.every((other) =>
        reasonCounts[code] >= reasonCounts[other],
      ),
    );
    assert.deepEqual(summary, {
      totalCount: orders.length,
      shipReadyCount: ready,
      exceptionCount: exceptions,
      reasonCounts,
      topReasonCodes,
    });
    assert.equal(summary.shipReadyCount + summary.exceptionCount, summary.totalCount);
  });
}

const singleReasonCases: { code: ReasonCode; overrides: Partial<OrderInput> }[] = [
  { code: "INVALID_QUANTITY", overrides: { orderQuantity: 0 } },
  { code: "CUSTOMER_BLOCKED", overrides: { customerBlocked: true } },
  { code: "MATERIAL_BLOCKED", overrides: { materialBlocked: true } },
  { code: "INSUFFICIENT_STOCK", overrides: { availableQuantity: 0 } },
];

for (const { code, overrides } of singleReasonCases) {
  test(`${code} 사유를 집계하고 단독 최다 사유로 반환한다`, () => {
    const { summary } = analyzeOrderBatch([
      normalOrder,
      { ...normalOrder, ...overrides },
    ]);
    assert.deepEqual(summary, {
      totalCount: 2,
      shipReadyCount: 1,
      exceptionCount: 1,
      reasonCounts: { ...zeroReasonCounts(), [code]: 1 },
      topReasonCodes: [code],
    });
  });
}

test("한 예외 주문의 복수 사유를 각각 집계하고 동률 사유를 고정 순서로 반환한다", () => {
  const { summary } = analyzeOrderBatch([
    { ...normalOrder, customerBlocked: true, materialBlocked: true, availableQuantity: 0 },
  ]);
  assert.deepEqual(summary, {
    totalCount: 1,
    shipReadyCount: 0,
    exceptionCount: 1,
    reasonCounts: {
      INVALID_QUANTITY: 0,
      CUSTOMER_BLOCKED: 1,
      MATERIAL_BLOCKED: 1,
      INSUFFICIENT_STOCK: 1,
    },
    topReasonCodes: ["CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"],
  });
});

test("네 사유의 동률은 입력 순서와 관계없이 지정된 순서로 반환한다", () => {
  const orders = [...singleReasonCases].reverse().map(({ overrides }) => ({
    ...normalOrder,
    ...overrides,
  }));
  assert.deepEqual(analyzeOrderBatch(orders).summary, {
    totalCount: 4,
    shipReadyCount: 0,
    exceptionCount: 4,
    reasonCounts: {
      INVALID_QUANTITY: 1,
      CUSTOMER_BLOCKED: 1,
      MATERIAL_BLOCKED: 1,
      INSUFFICIENT_STOCK: 1,
    },
    topReasonCodes: ["INVALID_QUANTITY", "CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"],
  });
});

test("최대 건수보다 적은 양수 사유는 최다 사유에서 제외한다", () => {
  const { summary } = analyzeOrderBatch([
    { ...normalOrder, customerBlocked: true, materialBlocked: true },
    { ...normalOrder, customerBlocked: true },
    { ...normalOrder, availableQuantity: 0 },
  ]);
  assert.deepEqual(summary.reasonCounts, {
    INVALID_QUANTITY: 0,
    CUSTOMER_BLOCKED: 2,
    MATERIAL_BLOCKED: 1,
    INSUFFICIENT_STOCK: 1,
  });
  assert.deepEqual(summary.topReasonCodes, ["CUSTOMER_BLOCKED"]);
});

test("빈 입력과 정상 주문만 있는 입력은 모든 사유가 0건이며 최다 사유가 없다", () => {
  for (const orders of [[], [normalOrder, normalOrder]]) {
    const { summary } = analyzeOrderBatch(orders);
    assert.deepEqual(summary, {
      totalCount: orders.length,
      shipReadyCount: orders.length,
      exceptionCount: 0,
      reasonCounts: zeroReasonCounts(),
      topReasonCodes: [],
    });
  }
});

test("입력 순서와 중복 주문을 보존한다", () => {
  const orders = [normalOrder, exceptionOrder, { ...normalOrder, orderId: "SO-002" }, normalOrder];
  assert.deepEqual(analyzeOrderBatch(orders).results.map((result) => result.orderId), [
    "SO-003", "SO-001", "SO-002", "SO-003",
  ]);
});

test("동일 객체 및 동일 주문 ID의 중복 입력을 항목마다 집계한다", () => {
  const blockedOrder = { ...normalOrder, customerBlocked: true, materialBlocked: true };
  const orders = [blockedOrder, blockedOrder, { ...blockedOrder }];
  const { results, summary } = analyzeOrderBatch(orders);
  assert.deepEqual(results, orders.map((order) => ({
    orderId: order.orderId,
    ...analyzeOrder(order),
  })));
  assert.deepEqual(summary, {
    totalCount: 3,
    shipReadyCount: 0,
    exceptionCount: 3,
    reasonCounts: {
      INVALID_QUANTITY: 0,
      CUSTOMER_BLOCKED: 3,
      MATERIAL_BLOCKED: 3,
      INSUFFICIENT_STOCK: 0,
    },
    topReasonCodes: ["CUSTOMER_BLOCKED", "MATERIAL_BLOCKED"],
  });
});

test("읽기 전용 입력 배열과 주문 객체를 변경하지 않고 반복 호출 결과가 동일하다", () => {
  const orders = Object.freeze([normalOrder, exceptionOrder]);
  const snapshot = orders.map((order) => ({ ...order }));
  const first = analyzeOrderBatch(orders);
  assert.deepEqual(analyzeOrderBatch(orders), first);
  assert.deepEqual(orders, snapshot);
  first.results[1]!.reasonCodes.length = 0;
  first.results.reverse();
  assert.deepEqual(analyzeOrderBatch(orders).results, orders.map((order) => ({
    orderId: order.orderId,
    ...analyzeOrder(order),
  })));
  assert.deepEqual(orders, snapshot);
});

test("집계 객체와 최다 사유 배열은 호출마다 독립적이다", () => {
  const orders = [{ ...normalOrder, customerBlocked: true }];
  const first = analyzeOrderBatch(orders);
  const second = analyzeOrderBatch(orders);
  assert.notStrictEqual(first.summary.reasonCounts, second.summary.reasonCounts);
  assert.notStrictEqual(first.summary.topReasonCodes, second.summary.topReasonCodes);
  first.summary.reasonCounts.CUSTOMER_BLOCKED = 99;
  first.summary.reasonCounts.INVALID_QUANTITY = 10;
  first.summary.topReasonCodes.length = 0;
  const expectedSummary = {
    totalCount: 1,
    shipReadyCount: 0,
    exceptionCount: 1,
    reasonCounts: { ...zeroReasonCounts(), CUSTOMER_BLOCKED: 1 },
    topReasonCodes: ["CUSTOMER_BLOCKED"],
  };
  assert.deepEqual(second.summary, expectedSummary);
  assert.deepEqual(analyzeOrderBatch(orders).summary, expectedSummary);
  assert.deepEqual(analyzeOrderBatch([]).summary.reasonCounts, zeroReasonCounts());
  assert.deepEqual(analyzeOrderBatch([normalOrder]).summary.topReasonCodes, []);
  assert.deepEqual(second.summary, expectedSummary);
});
