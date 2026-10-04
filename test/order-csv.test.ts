import assert from "node:assert/strict";
import test from "node:test";
import { createExceptionCsv, createSupplyRiskCsv, parseCsvOrders, parseCsvOrdersForUpload, preflightCsvUploadReferences, validateOrders } from "../src/order-csv.js";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { formatOrderSummary } from "../src/order-summary.js";
import type { DecisionContextProvider } from "../src/decision-context.js";
import { localDecisionContextProvider } from "../src/local-decision-reference.js";

test("CSV 주문을 숫자, 불리언 및 인용된 선택 필드로 변환한다", () => {
  const orders = parseCsvOrders("orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked,estimatedAmount,dueDate,orderComment\nORD-1,CUST-1,MAT-1,3,10,false,true,1200,2026-01-20,\"긴급, 확인 필요\"\n");
  assert.deepEqual(orders, [{ orderId: "ORD-1", customerId: "CUST-1", materialId: "MAT-1", orderQuantity: 3, availableQuantity: 10, customerBlocked: false, materialBlocked: true, estimatedAmount: 1200, dueDate: "2026-01-20", orderComment: "긴급, 확인 필요" }]);
  assert.doesNotThrow(() => validateOrders(orders));
});

test("CSV 필수 열과 데이터 형식을 검증한다", () => {
  assert.throws(() => parseCsvOrders("orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked\nORD-1,CUST-1,MAT-1,3,10,false\n"), /materialBlocked/);
  assert.throws(() => parseCsvOrders("orderId,customerId,materialId,orderQuantity,availableQuantity,customerBlocked,materialBlocked\nORD-1,CUST-1,MAT-1,nope,10,false,false\n"), /orderQuantity/);
});

const businessHeader = "orderId,customerId,materialId,orderQuantity";
const legacyHeader = `${businessHeader},availableQuantity,customerBlocked,materialBlocked`;
const upload = (source: string) => parseCsvOrdersForUpload(source, localDecisionContextProvider);
const noLookup: DecisionContextProvider = {
  getCustomerBlocked: () => { throw new Error("조회하면 안 됩니다"); },
  getMaterialBlocked: () => { throw new Error("조회하면 안 됩니다"); },
  getAvailableQuantity: () => { throw new Error("조회하면 안 됩니다"); },
};

test("업무 CSV는 BOM, CRLF, 열 순서, 인용된 선택 필드와 빈 선택 값을 지원한다", () => {
  const source = '\uFEFFmaterialId,orderQuantity,customerId,orderId,estimatedAmount,dueDate,orderComment\r\nM-1,10,C-1,SO-1,1200.5,2026-10-15,"확인, 요청\r\n""긴급"""\r\nM-2,0,C-2,SO-2,,,\r\n';
  const orders = upload(source);
  assert.deepEqual(orders, [
    { orderId: "SO-1", customerId: "C-1", materialId: "M-1", orderQuantity: 10, estimatedAmount: 1200.5, dueDate: "2026-10-15", orderComment: '확인, 요청\r\n"긴급"', availableQuantity: 20, customerBlocked: false, materialBlocked: false },
    { orderId: "SO-2", customerId: "C-2", materialId: "M-2", orderQuantity: 0, availableQuantity: 0, customerBlocked: true, materialBlocked: true },
  ]);
  assert.deepEqual(preflightCsvUploadReferences(source, localDecisionContextProvider), {
    status: "ready", upload: { orders, referenceSource: "provider" },
  });
  validateOrders(orders);
  assert.deepEqual(upload(businessHeader), []);
});

test("업무 필드와 CSV 구조를 조회 전에 검증한다", () => {
  const cases: [string, RegExp][] = [
    ["", /CSV 헤더가 필요/],
    ["orderId,customerId,materialId", /필수 필드 orderQuantity/],
    [`${businessHeader},unknown`, /알 수 없는 필드/],
    [`${businessHeader},orderId`, /중복/],
    [`${businessHeader}\nSO-1,C-1,M-1`, /헤더는 4개/],
    [`${businessHeader}\n,C-1,M-1,1`, /orderId/],
    [`${businessHeader}\nSO-1, ,M-1,1`, /customerId/],
    [`${businessHeader}\nSO-1,C-1, ,1`, /materialId/],
    [`${businessHeader}\nSO-1,C-1,M-1,`, /orderQuantity/],
    [`${businessHeader}\nSO-1,C-1,M-1,Infinity`, /orderQuantity/],
    [`${businessHeader},estimatedAmount\nSO-1,C-1,M-1,1,nope`, /estimatedAmount/],
    [`${businessHeader}\nSO-1,C-1,M-1,1\nSO-2,C-1,M-1,nope`, /2번째 행 orderQuantity/],
    [`${businessHeader}\n"SO-1,C-1,M-1,1`, /닫히지 않은 큰따옴표/],
  ];
  for (const [source, expected] of cases) {
    assert.throws(() => parseCsvOrdersForUpload(source, noLookup), expected);
    assert.throws(() => preflightCsvUploadReferences(source, noLookup), expected);
  }
});

test("일부 판정 열만 있으면 기존 필수 열 오류를 반환한다", () => {
  const decisionFields = ["availableQuantity", "customerBlocked", "materialBlocked"];
  for (let mask = 1; mask < 7; mask += 1) {
    const subset = decisionFields.filter((_, index) => mask & (1 << index));
    const source = `${businessHeader},${subset.join(",")}`;
    let expected = "";
    try { parseCsvOrders(source); } catch (error) { expected = (error as Error).message; }
    assert.notEqual(expected, "");
    assert.throws(() => parseCsvOrdersForUpload(source, noLookup), { message: expected });
    assert.throws(() => preflightCsvUploadReferences(source, noLookup), { message: expected });
  }
});

test("기존 형식은 기준 조회 없이 기존 입력 값과 오류 계약을 보존한다", () => {
  const source = `${legacyHeader}\nSO-1,UNKNOWN,UNKNOWN,10,30,true,false\n`;
  assert.deepEqual(parseCsvOrdersForUpload(source, noLookup), parseCsvOrders(source));
  assert.deepEqual(preflightCsvUploadReferences(source, noLookup), {
    status: "ready", upload: { orders: parseCsvOrders(source), referenceSource: "csv" },
  });
  for (const invalid of [
    `${legacyHeader}\nSO-1,C-1,M-1,10,,false,false`,
    `${legacyHeader}\nSO-1,C-1,M-1,10,20,FALSE,false`,
    `${legacyHeader}\nSO-1,C-1,M-1,10,20,false,`,
  ]) {
    let message = "";
    try { parseCsvOrders(invalid); } catch (error) { message = (error as Error).message; }
    assert.notEqual(message, "");
    assert.throws(() => parseCsvOrdersForUpload(invalid, noLookup), { message });
    assert.throws(() => preflightCsvUploadReferences(invalid, noLookup), { message });
  }
  // CLI가 사용하는 기존 진입점 및 JSON 검증은 업무 필드만 있는 입력을 계속 거부한다.
  assert.throws(() => parseCsvOrders(`${businessHeader}\nSO-1,C-1,M-1,10`), /필수 필드 availableQuantity/);
  assert.throws(() => validateOrders([{ orderId: "SO-1", customerId: "C-1", materialId: "M-1", orderQuantity: 10 }]), /availableQuantity/);
});

test("대표 CSV의 판정 열을 제거해도 분석, 요약, 예외 출력이 동일하다", () => {
  const optional = ",estimatedAmount,dueDate,orderComment";
  const business = `${businessHeader}${optional}\nSO-1,C-1,M-1,10,1200,2026-10-15,\nSO-2,C-2,M-2,5,200,2026-10-14,"확인, 요청"\nSO-3,C-1,M-1,0,,,\nSO-4,C-1,M-1,25,,,\n`;
  const legacy = `${legacyHeader}${optional}\nSO-1,C-1,M-1,10,20,false,false,1200,2026-10-15,\nSO-2,C-2,M-2,5,0,true,true,200,2026-10-14,"확인, 요청"\nSO-3,C-1,M-1,0,20,false,false,,,\nSO-4,C-1,M-1,25,20,false,false,,,\n`;
  const expected = parseCsvOrders(legacy);
  const actual = upload(business);
  assert.deepEqual(preflightCsvUploadReferences(business, localDecisionContextProvider), {
    status: "ready", upload: { orders: expected, referenceSource: "provider" },
  });
  validateOrders(actual);
  assert.deepEqual(actual, expected);
  const expectedBatch = analyzeOrderBatch(expected);
  const actualBatch = analyzeOrderBatch(actual);
  assert.deepEqual(actualBatch, expectedBatch);
  assert.deepEqual(formatOrderSummary(actualBatch.summary), formatOrderSummary(expectedBatch.summary));
  assert.equal(createExceptionCsv(actual, actualBatch), createExceptionCsv(expected, expectedBatch));
  assert.deepEqual(actualBatch.results.map((result) => result.reasonCodes), [[], ["CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"], ["INVALID_QUANTITY"], ["INSUFFICIENT_STOCK"]]);
  assert.deepEqual(upload(business), actual);
});

test("뒤쪽 주문의 조회 실패도 전체 업로드를 거부한다", () => {
  assert.throws(() => upload(`${businessHeader}\nSO-1,C-1,M-1,10\nSO-2,C-missing,M-1,10`), /SO-2.*고객.*C-missing/);
  assert.throws(() => upload(`${businessHeader}\nSO-1,C-1,M-1,10\nSO-2,C-1,M-missing,10`), /SO-2.*자재.*M-missing/);
  assert.deepEqual(preflightCsvUploadReferences(
    `${businessHeader}\nSO-1,C-1,M-1,10\nSO-2,C-missing,M-1,10\nSO-3,C-1,M-missing,10`, localDecisionContextProvider,
  ), {
    status: "missing-references",
    missingReferences: [
      { orderIndex: 1, orderId: "SO-2", referenceKind: "customer", identifier: "C-missing" },
      { orderIndex: 2, orderId: "SO-3", referenceKind: "material", identifier: "M-missing" },
      { orderIndex: 2, orderId: "SO-3", referenceKind: "inventory", identifier: "M-missing" },
    ],
  });
});

test("정상 판정 주문의 누적 배분 부족을 공급 위험 CSV에 포함한다", () => {
  const orders = [
    { orderId: "SO-1", customerId: "C-1", materialId: "M-1", orderQuantity: 6, availableQuantity: 10, customerBlocked: false, materialBlocked: false, dueDate: "2026-10-01" },
    { orderId: "SO-2", customerId: "C-1", materialId: "M-1", orderQuantity: 6, availableQuantity: 10, customerBlocked: false, materialBlocked: false, dueDate: "2026-10-02" },
  ];
  const batch = analyzeOrderBatch(orders);
  assert.deepEqual(batch.results.map((result) => result.status), ["SHIP_READY", "SHIP_READY"]);
  assert.equal(createExceptionCsv(orders, batch), "\uFEFF주문번호,자재,수량,거래처,예상금액,납기일,주문 코멘트,예외 사유\n");
  assert.equal(createSupplyRiskCsv(batch), "\uFEFF주문번호,자재,거래처,납기일,주문수량,부족수량,예상금액\nSO-2,M-1,C-1,2026-10-02,6,2,\n");
});

test("공급 위험 CSV는 계산 불가 자재와 부족량 0을 제외하고 셀을 이스케이프한다", () => {
  const orders = [
    { orderId: "SO-1", customerId: "C-1", materialId: "M,1", orderQuantity: 6, availableQuantity: 10, customerBlocked: false, materialBlocked: false, dueDate: "2026-10-01" },
    { orderId: 'SO-"2"', customerId: "C-1", materialId: "M,1", orderQuantity: 6, availableQuantity: 10, customerBlocked: false, materialBlocked: false, dueDate: "2026-10-02" },
    { orderId: "SO-3", customerId: "C-1", materialId: "M-2", orderQuantity: 5, availableQuantity: 0, customerBlocked: false, materialBlocked: false },
    { orderId: "SO-4", customerId: "C-1", materialId: "M-3", orderQuantity: 5, availableQuantity: 5, customerBlocked: false, materialBlocked: false, dueDate: "2026-10-03" },
  ];
  const batch = analyzeOrderBatch(orders);
  assert.deepEqual(batch.stockAllocations.map((allocation) => allocation.status), ["CALCULATED", "UNABLE_TO_CALCULATE", "CALCULATED"]);
  assert.equal(createSupplyRiskCsv(batch), '\uFEFF주문번호,자재,거래처,납기일,주문수량,부족수량,예상금액\n"SO-""2""","M,1",C-1,2026-10-02,6,2,\n');
});

test("납기일이 없는 주문만 제외하고 같은 자재의 나머지 주문 부족을 공급 위험 CSV에 포함한다", () => {
  const make = (orderId: string, orderQuantity: number, dueDate?: string) => ({
    orderId, customerId: "C-1", materialId: "M-1", orderQuantity, availableQuantity: 20, customerBlocked: false, materialBlocked: false,
    ...(dueDate === undefined ? {} : { dueDate }),
  });
  const orders = [make("SO-1", 15, "2026-10-01"), make("SO-2", 5), make("SO-3", 10, "2026-10-02")];
  const batch = analyzeOrderBatch(orders);
  assert.equal(batch.stockAllocations[0]!.status, "CALCULATED");
  assert.equal(createSupplyRiskCsv(batch), "\uFEFF주문번호,자재,거래처,납기일,주문수량,부족수량,예상금액\nSO-3,M-1,C-1,2026-10-02,10,5,\n");
});

test("부족 주문이 없으면 공급 위험 CSV에 헤더만 출력한다", () => {
  const orders = [
    { orderId: "SO-1", customerId: "C-1", materialId: "M-1", orderQuantity: 5, availableQuantity: 5, customerBlocked: false, materialBlocked: false, dueDate: "2026-10-01" },
    { orderId: "SO-2", customerId: "C-1", materialId: "M-2", orderQuantity: 5, availableQuantity: 0, customerBlocked: false, materialBlocked: false },
  ];
  assert.equal(createSupplyRiskCsv(analyzeOrderBatch(orders)), "\uFEFF주문번호,자재,거래처,납기일,주문수량,부족수량,예상금액\n");
  assert.equal(createSupplyRiskCsv(analyzeOrderBatch([])), "\uFEFF주문번호,자재,거래처,납기일,주문수량,부족수량,예상금액\n");
});

test("공급 위험 CSV는 납기, 예상금액, 입력 순서로 정렬하고 빈·음수 금액은 빈 셀로 뒤에 둔다", () => {
  const make = (orderId: string, dueDate: string, estimatedAmount?: number) => ({
    orderId, customerId: "C-1", materialId: "M-1", orderQuantity: 1, availableQuantity: 0, customerBlocked: false, materialBlocked: false, dueDate,
    ...(estimatedAmount === undefined ? {} : { estimatedAmount }),
  });
  const orders = [
    make("A", "2026-10-02", 100),
    make("B", "2026-10-01", 20),
    make("C", "2026-10-01", 200),
    make("D", "2026-10-01"),
    make("E", "2026-10-01", -5),
    make("F", "2026-10-01", 200),
  ];
  assert.equal(createSupplyRiskCsv(analyzeOrderBatch(orders)), [
    "\uFEFF주문번호,자재,거래처,납기일,주문수량,부족수량,예상금액",
    "C,M-1,C-1,2026-10-01,1,1,200",
    "F,M-1,C-1,2026-10-01,1,1,200",
    "B,M-1,C-1,2026-10-01,1,1,20",
    "D,M-1,C-1,2026-10-01,1,1,",
    "E,M-1,C-1,2026-10-01,1,1,",
    "A,M-1,C-1,2026-10-02,1,1,100",
    "",
  ].join("\n"));
});
