import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeOrder } from "../src/order-analysis.js";
import { parseCsvOrders, validateOrders } from "../src/order-csv.js";
import { createOrderCsvTemplate } from "../src/order-csv-template.js";

test("예제 다운로드 원본은 BOM과 필수 7개·선택 3개 열을 포함하며 기존 파서와 검증을 통과한다", () => {
  const source = createOrderCsvTemplate();
  assert.equal(source.charCodeAt(0), 0xFEFF);
  assert.deepEqual(source.slice(1).split(/\r?\n/)[0]!.split(","), [
    "orderId", "customerId", "materialId", "orderQuantity",
    "availableQuantity", "customerBlocked", "materialBlocked",
    "estimatedAmount", "dueDate", "orderComment",
  ]);
  // BOM 제거 등 전처리 없이 다운로드할 문자열 그대로 파싱한다.
  const orders = parseCsvOrders(source);
  assert.doesNotThrow(() => validateOrders(orders));
  assert.equal(orders.length, 2);
  const [ready, exception] = orders;
  assert.ok(ready);
  assert.ok(exception);
  assert.equal(ready.estimatedAmount, 150000);
  assert.equal(ready.dueDate, "2026-10-01");
  assert.equal(ready.orderComment, "예제 주문");
  for (const field of ["estimatedAmount", "dueDate", "orderComment"]) {
    assert.equal(Object.hasOwn(exception, field), false);
  }
});

test("예제 주문은 정상 1건과 고객·자재 차단 및 재고 부족 예외 1건으로 판정된다", () => {
  const orders = parseCsvOrders(createOrderCsvTemplate());
  validateOrders(orders);
  const results = orders.map((order) => analyzeOrder(order));
  assert.deepEqual(results.map(({ status, reasonCodes }) => ({ status, reasonCodes })), [
    { status: "SHIP_READY", reasonCodes: [] },
    {
      status: "EXCEPTION",
      reasonCodes: ["CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"],
    },
  ]);
});
