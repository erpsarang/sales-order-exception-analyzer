import assert from "node:assert/strict";
import test from "node:test";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { analyzeOrder, type OrderInput } from "../src/order-analysis.js";

const base: OrderInput = {
  orderId: "SO-1",
  customerId: "C-1",
  materialId: "M-1",
  orderQuantity: 10,
  availableQuantity: 100,
  customerBlocked: false,
  materialBlocked: false,
  dueDate: "2026-10-01",
};

test("납기순으로 현재 재고를 배분하고 부족이 시작되는 주문을 원래 위치로 연결한다", () => {
  const orders: OrderInput[] = [
    { ...base, orderId: "SO-3", orderQuantity: 40, dueDate: "2026-10-03" },
    { ...base, orderId: "SO-1", orderQuantity: 30, dueDate: "2026-10-01" },
    { ...base, orderId: "SO-2", orderQuantity: 50, dueDate: "2026-10-02" },
  ];
  const batch = analyzeOrderBatch(orders);
  assert.deepEqual(batch.stockAllocations, [{
    materialId: "M-1", status: "CALCULATED", availableQuantity: 100,
    items: [
      { resultIndex: 1, orderId: "SO-1", materialId: "M-1", dueDate: "2026-10-01", allocatedQuantity: 30, shortageQuantity: 0 },
      { resultIndex: 2, orderId: "SO-2", materialId: "M-1", dueDate: "2026-10-02", allocatedQuantity: 50, shortageQuantity: 0 },
      { resultIndex: 0, orderId: "SO-3", materialId: "M-1", dueDate: "2026-10-03", allocatedQuantity: 20, shortageQuantity: 20 },
    ],
  }]);
  assert.deepEqual(batch.results, orders.map((order) => ({
    orderId: order.orderId,
    orderDetails: { materialId: order.materialId, orderQuantity: order.orderQuantity, customerId: order.customerId, dueDate: order.dueDate },
    ...analyzeOrder(order),
  })));
  assert.equal(batch.summary.shipReadyCount, 3);
  assert.equal(batch.summary.exceptionCount, 0);
});

test("같은 납기는 입력 위치로 정렬하고 차단된 주문도 수요에 포함한다", () => {
  const orders = [
    { ...base, orderId: "A", orderQuantity: 60, customerBlocked: true },
    { ...base, orderId: "B", orderQuantity: 60 },
  ];
  const batch = analyzeOrderBatch(orders);
  const allocation = batch.stockAllocations[0]!;
  assert.equal(allocation.status, "CALCULATED");
  assert.deepEqual(allocation.items.map(({ resultIndex, allocatedQuantity, shortageQuantity }) => ({ resultIndex, allocatedQuantity, shortageQuantity })), [
    { resultIndex: 0, allocatedQuantity: 60, shortageQuantity: 0 },
    { resultIndex: 1, allocatedQuantity: 40, shortageQuantity: 20 },
  ]);
  assert.deepEqual(batch.results[0]!.reasonCodes, ["CUSTOMER_BLOCKED"]);
  assert.deepEqual(batch.results[1]!.reasonCodes, []);
});

test("납기, 주문수량, 가용재고가 유효하지 않거나 재고 값이 충돌하면 자재 전체를 계산 불가로 표시한다", () => {
  const cases: Array<{ orders: OrderInput[]; reason: string }> = [
    { orders: [{ ...base, dueDate: "2026-02-30" }, base], reason: "INVALID_DUE_DATE" },
    { orders: [{ ...base, orderQuantity: 0 }, base], reason: "INVALID_QUANTITY" },
    { orders: [{ ...base, availableQuantity: -1 }, { ...base, availableQuantity: -1 }], reason: "INVALID_AVAILABLE_QUANTITY" },
    { orders: [base, { ...base, availableQuantity: 90 }], reason: "CONFLICTING_AVAILABLE_QUANTITY" },
  ];
  for (const { orders, reason } of cases) {
    const allocation = analyzeOrderBatch(orders).stockAllocations[0]!;
    assert.equal(allocation.status, "UNABLE_TO_CALCULATE");
    if (allocation.status === "UNABLE_TO_CALCULATE") assert.ok(allocation.reasons.includes(reason as typeof allocation.reasons[number]));
    assert.deepEqual(allocation.items, []);
  }
});

test("한 자재의 계산 불가는 다른 자재의 배분에 영향을 주지 않고 반복 호출도 독립적이다", () => {
  const orders = Object.freeze([
    Object.freeze({ ...base, dueDate: "" }),
    Object.freeze({ ...base, materialId: "M-2", orderQuantity: 5, availableQuantity: 5 }),
  ]);
  const first = analyzeOrderBatch(orders);
  const second = analyzeOrderBatch(orders);
  assert.equal(first.stockAllocations[0]!.status, "UNABLE_TO_CALCULATE");
  assert.deepEqual(first.stockAllocations[1], {
    materialId: "M-2", status: "CALCULATED", availableQuantity: 5,
    items: [{ resultIndex: 1, orderId: "SO-1", materialId: "M-2", dueDate: "2026-10-01", allocatedQuantity: 5, shortageQuantity: 0 }],
  });
  assert.notStrictEqual(first.stockAllocations, second.stockAllocations);
  assert.deepEqual(first, second);
  assert.deepEqual(analyzeOrderBatch([]).stockAllocations, []);
});
