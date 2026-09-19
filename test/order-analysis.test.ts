import assert from "node:assert/strict";
import test from "node:test";
import { analyzeOrder, type ExceptionGuide, type OrderInput, type ReasonCode } from "../src/order-analysis.js";

const normalOrder: Readonly<OrderInput> = Object.freeze({
  orderId: "SO-001",
  customerId: "C-001",
  materialId: "M-001",
  orderQuantity: 10,
  availableQuantity: 20,
  customerBlocked: false,
  materialBlocked: false,
});

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

const allReasons: ReasonCode[] = [
  "INVALID_QUANTITY", "CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK",
];

const allExceptions: Readonly<OrderInput> = Object.freeze({
  ...normalOrder,
  orderQuantity: 0,
  availableQuantity: -1,
  customerBlocked: true,
  materialBlocked: true,
});

test("정상 주문과 재고가 주문수량과 같은 주문은 출고 가능하다", () => {
  for (const availableQuantity of [20, 10]) {
    assert.deepEqual(analyzeOrder({ ...normalOrder, availableQuantity }), {
      status: "SHIP_READY",
      reasonCodes: [],
      exceptionGuides: [],
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
      exceptionGuides: [expectedGuides[reasonCode]],
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
    exceptionGuides: [
      expectedGuides.CUSTOMER_BLOCKED,
      expectedGuides.MATERIAL_BLOCKED,
      expectedGuides.INSUFFICIENT_STOCK,
    ],
  });
});

test("잘못된 수량도 다른 예외 판정을 생략하지 않고 네 사유를 순서대로 반환한다", () => {
  assert.deepEqual(analyzeOrder(allExceptions), {
    status: "EXCEPTION",
    reasonCodes: allReasons,
    exceptionGuides: allReasons.map((code) => expectedGuides[code]),
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
    exceptionGuides: [expectedGuides.CUSTOMER_BLOCKED],
  });
  assert.deepEqual(order, snapshot);
});

test("선택 상세 필드는 판정과 고정 안내에 영향을 주지 않고 입력을 보존한다", () => {
  const orders = [
    normalOrder,
    ...singleExceptions.map(([, overrides]) => ({ ...normalOrder, ...overrides })),
    allExceptions,
  ];
  const variants = [
    {},
    { estimatedAmount: 1250000, dueDate: "2026-10-15", orderComment: "오전 입고 요청" },
    { estimatedAmount: 0, dueDate: "", orderComment: "" },
    { estimatedAmount: -1, dueDate: "미정", orderComment: "  확인\n요청  " },
  ];
  for (const order of orders) {
    const expected = analyzeOrder(order);
    for (const details of variants) {
      const input = Object.freeze({ ...order, ...details });
      const snapshot = { ...input };
      assert.deepEqual(analyzeOrder(input), expected);
      assert.deepEqual(input, snapshot);
    }
  }
});

test("가이드 배열과 모든 항목은 호출 사이에서 독립적이다", () => {
  const snapshot = { ...allExceptions };
  const first = analyzeOrder(allExceptions);
  const second = analyzeOrder(allExceptions);
  const expected = {
    status: "EXCEPTION",
    reasonCodes: allReasons,
    exceptionGuides: allReasons.map((code) => expectedGuides[code]),
  };
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  assert.notStrictEqual(first.exceptionGuides, second.exceptionGuides);
  const guides = [...first.exceptionGuides, ...second.exceptionGuides];
  guides.forEach((guide, index) => {
    for (const other of guides.slice(index + 1)) assert.notStrictEqual(guide, other);
  });
  first.exceptionGuides.forEach((guide) => {
    guide.reasonCode = "INVALID_QUANTITY";
    guide.check = "변경";
    guide.action = "변경";
  });
  first.exceptionGuides.reverse();
  first.exceptionGuides.length = 0;
  assert.deepEqual(first.reasonCodes, allReasons);
  assert.deepEqual(second, expected);
  assert.deepEqual(analyzeOrder(allExceptions), expected);
  assert.deepEqual(allExceptions, snapshot);
});

test("정상 주문의 빈 가이드 배열도 호출마다 독립적이다", () => {
  const first = analyzeOrder(normalOrder);
  const second = analyzeOrder(normalOrder);
  assert.notStrictEqual(first.exceptionGuides, second.exceptionGuides);
  first.exceptionGuides.push({ ...expectedGuides.CUSTOMER_BLOCKED });
  assert.deepEqual(second, { status: "SHIP_READY", reasonCodes: [], exceptionGuides: [] });
  assert.deepEqual(analyzeOrder(normalOrder), second);
});
