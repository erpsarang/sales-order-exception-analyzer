import assert from "node:assert/strict";
import test from "node:test";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import type { OrderInput } from "../src/order-analysis.js";
import { formatOrderSummary } from "../src/order-summary.js";

const normal: OrderInput = {
  orderId: "SO-1", customerId: "C-1", materialId: "M-1",
  orderQuantity: 10, availableQuantity: 20, customerBlocked: false, materialBlocked: false,
};
const zeroCounts = {
  INVALID_QUANTITY: 0, CUSTOMER_BLOCKED: 0, MATERIAL_BLOCKED: 0, INSUFFICIENT_STOCK: 0,
};

test("예외율은 백분율의 소수 둘째 자리까지 반올림하고 끝자리 0을 제거한다", () => {
  const cases: [number, string][] = [
    [0, "0%"], [0.4, "40%"], [1 / 3, "33.33%"], [2 / 3, "66.67%"],
    [0.125, "12.5%"], [0.12345, "12.35%"], [1, "100%"],
  ];
  for (const [exceptionRate, expected] of cases) {
    assert.equal(formatOrderSummary({ exceptionRate, reasonCounts: zeroCounts, topReasonCodes: [] }).exceptionRateText, expected);
  }
});

test("양수 사유만 건수 내림차순으로 표시하며 최다 사유는 summary를 사용한다", () => {
  const display = formatOrderSummary({
    exceptionRate: 0.4,
    reasonCounts: { ...zeroCounts, CUSTOMER_BLOCKED: 2, INSUFFICIENT_STOCK: 3 },
    topReasonCodes: ["INSUFFICIENT_STOCK"],
  });
  assert.deepEqual(display, {
    exceptionRateText: "40%",
    reasonCounts: [
      { reasonCode: "INSUFFICIENT_STOCK", count: 3, text: "INSUFFICIENT_STOCK 3건" },
      { reasonCode: "CUSTOMER_BLOCKED", count: 2, text: "CUSTOMER_BLOCKED 2건" },
    ],
    reasonCountsText: "INSUFFICIENT_STOCK 3건, CUSTOMER_BLOCKED 2건",
    topReasonText: "INSUFFICIENT_STOCK",
  });
});

test("사유 건수의 동률은 기존 사유 순서이며 최다 사유 배열의 순서는 그대로 보존한다", () => {
  const display = formatOrderSummary({
    exceptionRate: 1,
    reasonCounts: { INSUFFICIENT_STOCK: 1, MATERIAL_BLOCKED: 1, CUSTOMER_BLOCKED: 1, INVALID_QUANTITY: 1 },
    topReasonCodes: ["INSUFFICIENT_STOCK", "MATERIAL_BLOCKED", "CUSTOMER_BLOCKED", "INVALID_QUANTITY"],
  });
  assert.deepEqual(display.reasonCounts.map(({ reasonCode }) => reasonCode), [
    "INVALID_QUANTITY", "CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK",
  ]);
  assert.equal(display.topReasonText, "INSUFFICIENT_STOCK, MATERIAL_BLOCKED, CUSTOMER_BLOCKED, INVALID_QUANTITY");
});

test("빈 입력과 정상 주문은 예외율 0%와 예외 없음을 표시한다", () => {
  for (const orders of [[], [normal]]) {
    assert.deepEqual(formatOrderSummary(analyzeOrderBatch(orders).summary), {
      exceptionRateText: "0%", reasonCounts: [], reasonCountsText: "예외 없음", topReasonText: "예외 없음",
    });
  }
});

test("배치의 복수 사유 집계와 예외율을 연결하고 주문 건수로 다시 계산하지 않는다", () => {
  const batch = analyzeOrderBatch([
    { ...normal, customerBlocked: true, availableQuantity: 0 }, normal, normal,
  ]);
  assert.deepEqual(formatOrderSummary(batch.summary), {
    exceptionRateText: "33.33%",
    reasonCounts: [
      { reasonCode: "CUSTOMER_BLOCKED", count: 1, text: "CUSTOMER_BLOCKED 1건" },
      { reasonCode: "INSUFFICIENT_STOCK", count: 1, text: "INSUFFICIENT_STOCK 1건" },
    ],
    reasonCountsText: "CUSTOMER_BLOCKED 1건, INSUFFICIENT_STOCK 1건",
    topReasonText: "CUSTOMER_BLOCKED, INSUFFICIENT_STOCK",
  });
  const suppliedSummary = {
    ...batch.summary, exceptionRate: 0.4,
    reasonCounts: { ...zeroCounts, MATERIAL_BLOCKED: 7 },
    topReasonCodes: ["MATERIAL_BLOCKED"] as const,
  };
  assert.deepEqual(formatOrderSummary(suppliedSummary), {
    exceptionRateText: "40%",
    reasonCounts: [{ reasonCode: "MATERIAL_BLOCKED", count: 7, text: "MATERIAL_BLOCKED 7건" }],
    reasonCountsText: "MATERIAL_BLOCKED 7건", topReasonText: "MATERIAL_BLOCKED",
  });
});

test("동결된 summary를 변경하지 않고 반복 호출 및 결과 변경 이후에도 같은 값을 반환한다", () => {
  const summary = analyzeOrderBatch([{ ...normal, customerBlocked: true, materialBlocked: true }]).summary;
  const snapshot = JSON.stringify(summary);
  Object.freeze(summary.reasonCounts);
  Object.freeze(summary.topReasonCodes);
  Object.freeze(summary.exceptionOrderIds);
  Object.freeze(summary);
  const first = formatOrderSummary(summary);
  const second = formatOrderSummary(summary);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first.reasonCounts, second.reasonCounts);
  first.reasonCounts[0]!.count = 99;
  first.reasonCounts[0]!.text = "변경";
  first.reasonCounts.reverse();
  assert.deepEqual(formatOrderSummary(summary), second);
  assert.equal(JSON.stringify(summary), snapshot);
});
