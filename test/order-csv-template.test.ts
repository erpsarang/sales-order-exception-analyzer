import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeOrder } from "../src/order-analysis.js";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { parseCsvOrders, parseCsvUpload, validateOrders } from "../src/order-csv.js";
import { createCsvDecisionContextProvider } from "../src/csv-decision-reference.js";
import { localDecisionContextProvider } from "../src/local-decision-reference.js";
import { createOrderCsvTemplate, createUploadedReferenceOrderCsvTemplate } from "../src/order-csv-template.js";

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

test("주문 단독용 양식은 웹 파싱에서도 주문에 직접 입력한 기준값을 유지한다", () => {
  const source = createOrderCsvTemplate();
  const upload = parseCsvUpload(source, localDecisionContextProvider);
  assert.notEqual(upload.referenceSource, "provider");
  assert.deepEqual(upload.orders, parseCsvOrders(source));
  validateOrders(upload.orders);
  const batch = analyzeOrderBatch(upload.orders);
  assert.equal(batch.summary.totalCount, 2);
  assert.equal(batch.summary.shipReadyCount, 1);
  assert.equal(batch.summary.exceptionCount, 1);
});

test("업로드용 양식 원본은 직접 판정 열 없이 두 기준 CSV와 함께 파싱·분석된다", () => {
  const source = createUploadedReferenceOrderCsvTemplate();
  assert.equal(source.charCodeAt(0), 0xFEFF);
  assert.ok(source.endsWith("\r\n"));
  assert.deepEqual(source.slice(1).split("\r\n")[0]!.split(","), [
    "orderId", "customerId", "materialId", "orderQuantity",
    "estimatedAmount", "dueDate", "orderComment",
  ]);
  // 주문 단독용 예제와 반대의 기준값으로 업로드 기준이 실제 판정에 반영되는지 확인한다.
  const provider = createCsvDecisionContextProvider(
    "customerId,customerBlocked\r\nEXAMPLE-C001,true\r\nEXAMPLE-C002,false\r\n",
    "materialId,materialBlocked,availableQuantity\r\nEXAMPLE-M001,true,2\r\nEXAMPLE-M002,false,30\r\n",
  );
  // 열 제거나 BOM 제거 없이 다운로드 원본을 그대로 사용한다.
  const upload = parseCsvUpload(source, provider);
  assert.equal(upload.referenceSource, "provider");
  assert.doesNotThrow(() => validateOrders(upload.orders));
  assert.equal(upload.orders.length, 2);
  const [first, second] = upload.orders;
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(upload.orders.map(({ availableQuantity, customerBlocked, materialBlocked }) => ({
    availableQuantity, customerBlocked, materialBlocked,
  })), [
    { availableQuantity: 2, customerBlocked: true, materialBlocked: true },
    { availableQuantity: 30, customerBlocked: false, materialBlocked: false },
  ]);
  assert.equal(first.estimatedAmount, 150000);
  assert.equal(first.dueDate, "2026-10-01");
  assert.equal(first.orderComment, "예제 주문");
  for (const field of ["estimatedAmount", "dueDate", "orderComment"]) {
    assert.equal(Object.hasOwn(second, field), false);
  }
  assert.deepEqual(upload.orders.map((order) => {
    const { status, reasonCodes } = analyzeOrder(order);
    return { status, reasonCodes };
  }), [
    {
      status: "EXCEPTION",
      reasonCodes: ["CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"],
    },
    { status: "SHIP_READY", reasonCodes: [] },
  ]);
  const batch = analyzeOrderBatch(upload.orders);
  assert.equal(batch.summary.totalCount, 2);
  assert.equal(batch.summary.shipReadyCount, 1);
  assert.equal(batch.summary.exceptionCount, 1);
});
