import assert from "node:assert/strict";
import test from "node:test";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { localDecisionContextProvider } from "../src/local-decision-reference.js";
import { createExceptionCsv, parseCsvOrders, parseCsvOrdersForUpload, parseCsvUpload, validateOrders } from "../src/order-csv.js";

const businessHeader = "orderId,customerId,materialId,orderQuantity";
const referenceFields = ["availableQuantity", "customerBlocked", "materialBlocked"];
const fullHeader = `${businessHeader},${referenceFields.join(",")}`;
const provider = localDecisionContextProvider;

const normalOrder = {
  orderId: "SO-1",
  customerId: "C-1",
  materialId: "M-1",
  orderQuantity: 10,
  availableQuantity: 20,
  customerBlocked: false,
  materialBlocked: false,
};

test("기준값을 생략한 정상 주문은 provider 출처와 실제 적용값을 반환한다", () => {
  const source = `${businessHeader}\nSO-1,C-1,M-1,10`;
  const upload = parseCsvUpload(source, provider);
  assert.deepEqual(upload, { orders: [normalOrder], referenceSource: "provider" });
  validateOrders(upload.orders);
  const batch = analyzeOrderBatch(upload.orders);
  assert.equal(batch.summary.shipReadyCount, 1);
  assert.equal(batch.results[0]!.status, "SHIP_READY");
  const legacy = parseCsvOrdersForUpload(source, provider);
  assert.ok(Array.isArray(legacy));
  assert.deepEqual(legacy, upload.orders);
  assert.throws(() => parseCsvOrders(source), /필수 필드 availableQuantity/);
});

test("예제와 동일한 값을 명시해도 출처는 csv이며 기존 공개 API는 배열을 반환한다", () => {
  const source = `${fullHeader}\nSO-1,C-1,M-1,10,20,false,false`;
  const upload = parseCsvUpload(source, provider);
  assert.deepEqual(upload, { orders: [normalOrder], referenceSource: "csv" });
  for (const orders of [parseCsvOrders(source), parseCsvOrdersForUpload(source, provider)]) {
    assert.ok(Array.isArray(orders));
    assert.deepEqual(orders, upload.orders);
  }
});

test("명시한 기준값은 로컬 등록 여부와 관계없이 그대로 적용한다", () => {
  const source = `${fullHeader}\nSO-X,C-X,M-X,10,3,true,false`;
  const upload = parseCsvUpload(source, provider);
  assert.equal(upload.referenceSource, "csv");
  assert.deepEqual(upload.orders, [{
    orderId: "SO-X", customerId: "C-X", materialId: "M-X", orderQuantity: 10,
    availableQuantity: 3, customerBlocked: true, materialBlocked: false,
  }]);
  assert.deepEqual(analyzeOrderBatch(upload.orders).results[0]!.reasonCodes, ["CUSTOMER_BLOCKED", "INSUFFICIENT_STOCK"]);
});

test("BOM, 헤더 순서, 인용 셀과 선택 필드를 보존한다", () => {
  const source = '\uFEFForderComment,materialId,orderQuantity,orderId,customerId,estimatedAmount,dueDate\r\n"확인, \"\"요청\"\"\n다음 줄",M-1,10,SO-1,C-1,0,2026-10-15\r\n';
  const upload = parseCsvUpload(source, provider);
  assert.equal(upload.referenceSource, "provider");
  assert.deepEqual(upload.orders, [{
    ...normalOrder, orderComment: '확인, "요청"\n다음 줄', estimatedAmount: 0, dueDate: "2026-10-15",
  }]);
  assert.deepEqual(parseCsvOrdersForUpload(source, provider), upload.orders);
  const explicit = '\uFEFFmaterialBlocked,materialId,availableQuantity,orderId,customerBlocked,customerId,orderQuantity\r\nfalse,M-1,20,SO-1,false,C-1,10\r\n';
  assert.deepEqual(parseCsvUpload(explicit, provider), { orders: [normalOrder], referenceSource: "csv" });
});

test("헤더만 있는 빈 입력도 파싱 분기에 따른 출처와 빈 배열을 반환한다", () => {
  assert.deepEqual(parseCsvUpload(businessHeader, provider), { orders: [], referenceSource: "provider" });
  assert.deepEqual(parseCsvUpload(fullHeader, provider), { orders: [], referenceSource: "csv" });
  assert.deepEqual(parseCsvOrdersForUpload(businessHeader, provider), []);
  assert.deepEqual(parseCsvOrders(fullHeader), []);
});

test("기준 열을 일부만 제공하는 모든 조합을 계속 거부한다", () => {
  const values = ["20", "false", "false"];
  for (let mask = 1; mask < 7; mask += 1) {
    const fields = referenceFields.filter((_, index) => (mask & (1 << index)) !== 0);
    const cells = values.filter((_, index) => (mask & (1 << index)) !== 0);
    const source = `${businessHeader},${fields.join(",")}\nSO-1,C-1,M-1,10,${cells.join(",")}`;
    assert.throws(() => parseCsvUpload(source, provider), /필수 필드/);
    assert.throws(() => parseCsvOrdersForUpload(source, provider), /필수 필드/);
  }
});

test("기존 헤더, 셀, 숫자 및 불리언 검증 오류를 보존한다", () => {
  const cases: Array<[string, RegExp]> = [
    ["", /CSV 헤더가 필요/],
    [`${businessHeader},unknown\nSO-1,C-1,M-1,10,x`, /알 수 없는 필드/],
    [`${businessHeader},orderId\nSO-1,C-1,M-1,10,SO-2`, /중복/],
    ["orderId,customerId,materialId\nSO-1,C-1,M-1", /필수 필드 orderQuantity/],
    [`${businessHeader}\nSO-1,C-1,M-1`, /헤더는 4개 필드인데 3개/],
    [`${businessHeader}\nSO-1, ,M-1,10`, /customerId: 비어 있지 않은 문자열/],
    [`${businessHeader}\nSO-1,C-1,M-1,`, /orderQuantity: 유한한 숫자/],
    [`${businessHeader}\nSO-1,C-1,M-1,Infinity`, /orderQuantity: 유한한 숫자/],
    [`${businessHeader},estimatedAmount\nSO-1,C-1,M-1,10,NaN`, /estimatedAmount: 유한한 숫자/],
    [`${fullHeader}\nSO-1,C-1,M-1,10,,false,false`, /availableQuantity: 유한한 숫자/],
    [`${fullHeader}\nSO-1,C-1,M-1,10,20,,false`, /customerBlocked: true 또는 false/],
    [`${fullHeader}\nSO-1,C-1,M-1,10,20,false,TRUE`, /materialBlocked: true 또는 false/],
    [`${businessHeader}\n"SO-1,C-1,M-1,10`, /닫히지 않은 큰따옴표/],
    [`${businessHeader}\n"SO-1"x,C-1,M-1,10`, /닫는 큰따옴표 뒤/],
  ];
  for (const [source, message] of cases) {
    assert.throws(() => parseCsvUpload(source, provider), message);
    assert.throws(() => parseCsvOrdersForUpload(source, provider), message);
  }
});

test("미등록 식별자의 보완 실패를 전달하고 모든 업무 행을 조회 전에 검증한다", () => {
  for (const row of ["SO-1,C-X,M-1,10", "SO-1,C-1,M-X,10"]) {
    const source = `${businessHeader}\n${row}`;
    assert.throws(() => parseCsvUpload(source, provider));
    assert.throws(() => parseCsvOrdersForUpload(source, provider));
  }
  const source = `${businessHeader}\nSO-1,C-X,M-X,10\nSO-2,C-1,M-1,NaN`;
  assert.throws(() => parseCsvUpload(source, provider), /CSV 데이터 2번째 행 orderQuantity: 유한한 숫자/);
});

test("정상, 예외, 중복 주문의 적용값과 배치 판정 및 다운로드 결과를 보존한다", () => {
  const business = `${businessHeader},estimatedAmount,dueDate,orderComment\nSO-1,C-1,M-1,10,,,\nSO-1,C-2,M-2,5,100,2026-10-15,차단 확인\nSO-2,C-1,M-1,25,200,2026-10-14,재고 확인\nSO-3,C-1,M-1,0,,,`;
  const explicit = `${fullHeader},estimatedAmount,dueDate,orderComment\nSO-1,C-1,M-1,10,20,false,false,,,\nSO-1,C-2,M-2,5,0,true,true,100,2026-10-15,차단 확인\nSO-2,C-1,M-1,25,20,false,false,200,2026-10-14,재고 확인\nSO-3,C-1,M-1,0,20,false,false,,,`;
  const upload = parseCsvUpload(business, provider);
  const expected = parseCsvOrders(explicit);
  assert.equal(upload.referenceSource, "provider");
  assert.equal(parseCsvUpload(explicit, provider).referenceSource, "csv");
  assert.deepEqual(upload.orders, expected);
  assert.deepEqual(parseCsvOrdersForUpload(business, provider), expected);
  validateOrders(upload.orders);
  const batch = analyzeOrderBatch(upload.orders);
  const expectedBatch = analyzeOrderBatch(expected);
  assert.deepEqual(batch, expectedBatch);
  assert.deepEqual(batch.results.map(({ reasonCodes }) => reasonCodes), [
    [], ["CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"], ["INSUFFICIENT_STOCK"], ["INVALID_QUANTITY"],
  ]);
  assert.equal(batch.summary.shipReadyCount, 1);
  assert.equal(batch.summary.exceptionCount, 3);
  assert.deepEqual(batch.exceptionWorklist.map(({ resultIndex }) => resultIndex), [2, 1, 3]);
  for (const includeStock of [false, true]) {
    assert.equal(createExceptionCsv(upload.orders, batch, includeStock), createExceptionCsv(expected, expectedBatch, includeStock));
  }
});
