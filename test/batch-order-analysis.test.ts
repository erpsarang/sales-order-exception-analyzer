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

const cases = [
  { name: "정상 주문만", orders: [normalOrder, { ...normalOrder, availableQuantity: 10 }], ready: 2, exceptions: 0 },
  { name: "예외 주문만", orders: [exceptionOrder, { ...normalOrder, availableQuantity: 0 }], ready: 0, exceptions: 2 },
  { name: "정상 및 예외 주문 혼합", orders: [normalOrder, exceptionOrder, { ...normalOrder, orderId: "SO-002" }], ready: 2, exceptions: 1 },
  { name: "빈 배열", orders: [], ready: 0, exceptions: 0 },
];

for (const { name, orders, ready, exceptions } of cases) {
  test(`${name}: 단일 주문과 동일한 판정 및 정확한 집계를 반환한다`, () => {
    const { results, summary } = analyzeOrderBatch(orders);
    assert.deepEqual(results, orders.map((order) => ({
      orderId: order.orderId,
      ...analyzeOrder(order),
    })));
    assert.deepEqual(summary, {
      totalCount: orders.length,
      shipReadyCount: ready,
      exceptionCount: exceptions,
    });
    assert.equal(summary.shipReadyCount + summary.exceptionCount, summary.totalCount);
  });
}

test("입력 순서와 중복 주문을 보존한다", () => {
  const orders = [normalOrder, exceptionOrder, { ...normalOrder, orderId: "SO-002" }, normalOrder];
  assert.deepEqual(analyzeOrderBatch(orders).results.map((result) => result.orderId), [
    "SO-003", "SO-001", "SO-002", "SO-003",
  ]);
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
