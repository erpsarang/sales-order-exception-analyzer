import assert from "node:assert/strict";
import test from "node:test";
import { analyzeOrder, type OrderInput, type ReasonCode } from "../src/order-analysis.js";

const normalOrder: Readonly<OrderInput> = Object.freeze({
  orderId: "SO-001",
  customerId: "C-001",
  materialId: "M-001",
  orderQuantity: 10,
  availableQuantity: 20,
  customerBlocked: false,
  materialBlocked: false,
});

test("정상 주문과 재고가 주문수량과 같은 주문은 출고 가능하다", () => {
  for (const availableQuantity of [20, 10]) {
    assert.deepEqual(analyzeOrder({ ...normalOrder, availableQuantity }), {
      status: "SHIP_READY",
      reasonCodes: [],
    });
  }
});

const singleExceptions: [string, Partial<OrderInput>, ReasonCode][] = [
  ["수량 0", { orderQuantity: 0 }, "INVALID_QUANTITY"],
  ["음수 수량", { orderQuantity: -1 }, "INVALID_QUANTITY"],
  ["고객 차단", { customerBlocked: true }, "CUSTOMER_BLOCKED"],
  ["자재 차단", { materialBlocked: true }, "MATERIAL_BLOCKED"],
  ["재고 부족", { availableQuantity: 9 }, "INSUFFICIENT_STOCK"],
];

for (const [name, overrides, reasonCode] of singleExceptions) {
  test(`${name} 단일 예외를 반환한다`, () => {
    assert.deepEqual(analyzeOrder({ ...normalOrder, ...overrides }), {
      status: "EXCEPTION",
      reasonCodes: [reasonCode],
    });
  });
}

test("고객 및 자재 차단과 재고 부족을 순서대로 모두 반환한다", () => {
  assert.deepEqual(analyzeOrder({
    ...normalOrder,
    customerBlocked: true,
    materialBlocked: true,
    availableQuantity: 0,
  }), {
    status: "EXCEPTION",
    reasonCodes: ["CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"],
  });
});

test("잘못된 수량도 다른 예외 판정을 생략하지 않고 네 사유를 순서대로 반환한다", () => {
  assert.deepEqual(analyzeOrder({
    ...normalOrder,
    orderQuantity: 0,
    availableQuantity: -1,
    customerBlocked: true,
    materialBlocked: true,
  }), {
    status: "EXCEPTION",
    reasonCodes: ["INVALID_QUANTITY", "CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"],
  });
});

test("입력은 변경하지 않으며 이전 결과 변경은 다음 판정에 영향을 주지 않는다", () => {
  const order = Object.freeze({ ...normalOrder, customerBlocked: true });
  const snapshot = { ...order };
  const first = analyzeOrder(order);
  assert.deepEqual(analyzeOrder(order), first);
  first.reasonCodes.length = 0;
  assert.deepEqual(analyzeOrder(order), {
    status: "EXCEPTION",
    reasonCodes: ["CUSTOMER_BLOCKED"],
  });
  assert.deepEqual(order, snapshot);
});
