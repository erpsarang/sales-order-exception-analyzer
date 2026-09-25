import assert from "node:assert/strict";
import test from "node:test";
import { createCsvDecisionContextProvider } from "../src/csv-decision-reference.js";
import { createDecisionContextProvider, enrichOrder } from "../src/decision-context.js";
import { parseCsvUpload } from "../src/order-csv.js";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";

const customerHeader = "customerId,customerBlocked";
const materialHeader = "materialId,materialBlocked,availableQuantity";
const customerCsv = `${customerHeader}\nC-1,false\nC-2,true\n`;
const materialCsv = `${materialHeader}\nM-1,false,20\nM-2,true,-1\n`;
const businessHeader = "orderId,customerId,materialId,orderQuantity";

const schemas = [
  {
    kind: "고객",
    fields: ["customerId", "customerBlocked"],
    header: customerHeader,
    row: "C-1,false",
    idField: "customerId",
    blockedField: "customerBlocked",
    create: (csv: string) => createCsvDecisionContextProvider(csv, materialCsv),
    withId: (id: string) => `${id},false`,
    withBoolean: (value: string) => `C-1,${value}`,
  },
  {
    kind: "자재/재고",
    fields: ["materialId", "materialBlocked", "availableQuantity"],
    header: materialHeader,
    row: "M-1,false,20",
    idField: "materialId",
    blockedField: "materialBlocked",
    create: (csv: string) => createCsvDecisionContextProvider(customerCsv, csv),
    withId: (id: string) => `${id},false,20`,
    withBoolean: (value: string) => `M-1,${value},20`,
  },
];

for (const schema of schemas) {
  test(`${schema.kind} CSV의 필수·중복·알 수 없는 헤더를 검증한다`, () => {
    for (const source of ["", "\uFEFF"]) {
      assert.throws(() => schema.create(source), new RegExp(`${schema.kind}.*1번째 행.*헤더가 필요`));
    }
    for (const missing of schema.fields) {
      const source = schema.fields.filter((field) => field !== missing).join(",");
      assert.throws(() => schema.create(source), new RegExp(`${schema.kind}.*1번째 행.*필수 필드 ${missing}`));
    }
    assert.throws(() => schema.create(`${schema.header},${schema.idField}`), new RegExp(`${schema.kind}.*1번째 행.*${schema.idField}.*중복`));
    assert.throws(() => schema.create(`${schema.header},unknown`), new RegExp(`${schema.kind}.*1번째 행.*알 수 없는 필드.*unknown`));
  });

  test(`${schema.kind} CSV의 열 개수와 인용 구문 오류에 위치와 원인이 있다`, () => {
    const cases: [string, RegExp][] = [
      [schema.row.split(",").slice(0, -1).join(","), /헤더는.*필드/],
      [`${schema.row},extra`, /헤더는.*필드/],
      ['"unterminated', /닫히지 않은 큰따옴표/],
      [schema.withId('bad"id'), /셀의 시작/],
      [schema.withId('"id"suffix'), /닫는 큰따옴표 뒤/],
      [schema.withId('"id" '), /닫는 큰따옴표 뒤/],
    ];
    for (const [row, reason] of cases) {
      for (const prefix of ["", `${schema.row}\n`, `${schema.withId('"multi\nline"')}\n`]) {
        const rowNumber = prefix === "" ? 1 : 2;
        assert.throws(() => schema.create(`${schema.header}\n${prefix}${row}`), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(`${schema.kind} 기준 CSV ${rowNumber}번째 행`));
          assert.match(error.message, reason);
          return true;
        });
      }
    }
    assert.throws(() => schema.create(`${schema.header}\n\n`), new RegExp(`${schema.kind}.*1번째 행.*헤더는`));
  });

  test(`${schema.kind} CSV의 헤더 구문 오류는 데이터 행과 구분한다`, () => {
    for (const source of ['"unterminated', 'bad"header', '"header"suffix']) {
      assert.throws(() => schema.create(source), new RegExp(`${schema.kind} 기준 CSV 1번째 행 헤더 1번째 열:`));
    }
  });

  test(`${schema.kind} CSV의 빈 식별자와 정확히 일치하는 중복을 거부한다`, () => {
    for (const id of ["", "   ", '"\t "']) {
      assert.throws(() => schema.create(`${schema.header}\n${schema.withId(id)}`), new RegExp(`${schema.kind}.*1번째 행 ${schema.idField}.*비어 있지 않은`));
    }
    assert.throws(() => schema.create(`${schema.header}\n${schema.row}\n${schema.row}`), new RegExp(`${schema.kind}.*2번째 행 ${schema.idField}.*1번째 행과 중복`));
    assert.throws(() => schema.create(`${schema.header}\n${schema.withId('"same"')}\n${schema.withId("same")}`), new RegExp(`${schema.kind}.*2번째 행.*same.*중복`));
  });

  test(`${schema.kind} CSV는 소문자 true/false만 허용한다`, () => {
    for (const value of ["", "TRUE", "False", "0", "1", "yes", " true", "false ", "null"]) {
      assert.throws(() => schema.create(`${schema.header}\n${schema.withBoolean(value)}`), new RegExp(`${schema.kind}.*1번째 행 ${schema.blockedField}.*true 또는 false`));
    }
  });
}

test("재고는 빈 값, 숫자가 아닌 값과 비유한 숫자를 거부한다", () => {
  for (const value of ["", "  ", "nope", "NaN", "Infinity", "-Infinity", "1e309"]) {
    assert.throws(() => createCsvDecisionContextProvider(customerCsv, `${materialHeader}\nM-1,false,20\nM-2,true,${value}`), /자재\/재고.*2번째 행 availableQuantity.*유한한 숫자/);
  }
  for (const value of ["0", "-1", "2.5", "1e2"]) {
    const provider = createCsvDecisionContextProvider(customerCsv, `${materialHeader}\nM-1,false,${value}`);
    assert.equal(provider.getAvailableQuantity("M-1"), Number(value));
  }
});

test("BOM, 열 순서, LF·CRLF, 인용 셀과 이중 큰따옴표 및 내부 줄바꿈을 보존한다", () => {
  const provider = createCsvDecisionContextProvider(
    '\uFEFF"customerBlocked",customerId\r\n"false"," C,""1""\r\nnext "\r\ntrue,C-2',
    '\uFEFFavailableQuantity,materialId,materialBlocked\n"2.5","M,""1""\nnext","true"\n-1,M-2,false\n',
  );
  const customerId = ' C,"1"\r\nnext ';
  const materialId = 'M,"1"\nnext';
  assert.equal(provider.getCustomerBlocked(customerId), false);
  assert.equal(provider.getCustomerBlocked("C-2"), true);
  assert.equal(provider.getMaterialBlocked(materialId), true);
  assert.equal(provider.getAvailableQuantity(materialId), 2.5);
  assert.equal(provider.getMaterialBlocked("M-2"), false);
  assert.equal(provider.getAvailableQuantity("M-2"), -1);
  const upload = parseCsvUpload(
    `${businessHeader}\nSO-quoted," C,""1""\r\nnext ","M,""1""\nnext",1`,
    provider,
  );
  assert.deepEqual(upload.orders, [{
    orderId: "SO-quoted", customerId, materialId, orderQuantity: 1,
    availableQuantity: 2.5, customerBlocked: false, materialBlocked: true,
  }]);
  assert.deepEqual(analyzeOrderBatch(upload.orders).results[0]!.reasonCodes, ["MATERIAL_BLOCKED"]);
});

test("식별자의 공백과 대소문자를 정규화하지 않고 원본 값으로 조회한다", () => {
  const provider = createCsvDecisionContextProvider(
    `${customerHeader}\nC-1,false\nc-1,true\n C-1 ,true\ntoString,false`,
    `${materialHeader}\nM-1,false,20\nm-1,true,5\n M-1 ,true,-1\n__proto__,false,0`,
  );
  assert.equal(provider.getCustomerBlocked("C-1"), false);
  assert.equal(provider.getCustomerBlocked("c-1"), true);
  assert.equal(provider.getCustomerBlocked(" C-1 "), true);
  assert.equal(provider.getCustomerBlocked("C-1 "), undefined);
  assert.equal(provider.getCustomerBlocked("toString"), false);
  assert.equal(provider.getMaterialBlocked("M-1"), false);
  assert.equal(provider.getMaterialBlocked("m-1"), true);
  assert.equal(provider.getAvailableQuantity(" M-1 "), -1);
  assert.equal(provider.getMaterialBlocked(" M-1"), undefined);
  assert.equal(provider.getAvailableQuantity(" M-1"), undefined);
  assert.equal(provider.getAvailableQuantity("__proto__"), 0);
  assert.equal(provider.getCustomerBlocked("missing"), undefined);
  assert.equal(provider.getMaterialBlocked("missing"), undefined);
  assert.equal(provider.getAvailableQuantity("missing"), undefined);
});

test("헤더만 있는 기준 CSV는 빈 조회기를 구성하고 기본값을 만들지 않는다", () => {
  const provider = createCsvDecisionContextProvider(customerHeader, `${materialHeader}\n`);
  assert.equal(provider.getCustomerBlocked("C-1"), undefined);
  assert.equal(provider.getMaterialBlocked("M-1"), undefined);
  assert.equal(provider.getAvailableQuantity("M-1"), undefined);
  assert.deepEqual(parseCsvUpload(businessHeader, provider), { orders: [], referenceSource: "provider" });
  assert.throws(() => parseCsvUpload(`${businessHeader}\nSO-empty,C-1,M-1,1`, provider), /SO-empty.*고객.*C-1.*데이터가 없습니다/);
});

test("미등록 고객·자재 오류는 기존 enrichOrder와 같고 실패한 주문과 기준을 식별한다", () => {
  const provider = createCsvDecisionContextProvider(customerCsv, materialCsv);
  const existingProvider = createDecisionContextProvider({
    customers: [{ customerId: "C-1", customerBlocked: false }, { customerId: "C-2", customerBlocked: true }],
    materials: [{ materialId: "M-1", materialBlocked: false }, { materialId: "M-2", materialBlocked: true }],
    inventory: [{ materialId: "M-1", availableQuantity: 20 }, { materialId: "M-2", availableQuantity: -1 }],
  });
  for (const [customerId, materialId, kind, missingId] of [
    ["C-missing", "M-1", "고객", "C-missing"],
    ["C-1", "M-missing", "자재", "M-missing"],
    ["C-missing", "M-missing", "고객", "C-missing"],
  ] as const) {
    const order = { orderId: "SO-missing", customerId, materialId, orderQuantity: 1 };
    let expected = "";
    try { enrichOrder(order, existingProvider); } catch (error) {
      assert.ok(error instanceof Error);
      expected = error.message;
    }
    assert.match(expected, new RegExp(`SO-missing.*${kind}.*${missingId}.*데이터가 없습니다`));
    assert.throws(() => enrichOrder(order, provider), { message: expected });
    assert.throws(() => parseCsvUpload(
      `${businessHeader}\nSO-valid,C-1,M-1,1\nSO-missing,${customerId},${materialId},1`, provider,
    ), { message: expected });
  }
});

test("실제 CSV 공급자로 보강한 주문과 전체 배치 결과는 판정 열 직접 입력과 동일하다", () => {
  const provider = createCsvDecisionContextProvider(customerCsv, materialCsv);
  const optional = ",estimatedAmount,dueDate,orderComment";
  const business = `${businessHeader}${optional}\nSO-3,C-1,M-1,15,1200,2026-10-15,\nSO-1,C-2,M-2,0,200,2026-10-16,"확인, 요청"\nSO-2,C-1,M-1,25,300,2026-10-14,긴급\nSO-3,C-1,M-1,15,,,\nSO-1,C-2,M-1,1,500,2026-10-14,고객 확인\n`;
  const direct = `${businessHeader},availableQuantity,customerBlocked,materialBlocked${optional}\nSO-3,C-1,M-1,15,20,false,false,1200,2026-10-15,\nSO-1,C-2,M-2,0,-1,true,true,200,2026-10-16,"확인, 요청"\nSO-2,C-1,M-1,25,20,false,false,300,2026-10-14,긴급\nSO-3,C-1,M-1,15,20,false,false,,,\nSO-1,C-2,M-1,1,20,true,false,500,2026-10-14,고객 확인\n`;
  const actual = parseCsvUpload(business, provider);
  const expected = parseCsvUpload(direct, provider);
  assert.equal(actual.referenceSource, "provider");
  assert.equal(expected.referenceSource, "csv");
  assert.deepEqual(actual.orders, expected.orders);
  const batch = analyzeOrderBatch(actual.orders);
  assert.deepEqual(batch, analyzeOrderBatch(expected.orders));
  assert.deepEqual(batch.results.map(({ orderId }) => orderId), ["SO-3", "SO-1", "SO-2", "SO-3", "SO-1"]);
  assert.deepEqual(batch.results.map(({ status }) => status), ["SHIP_READY", "EXCEPTION", "EXCEPTION", "SHIP_READY", "EXCEPTION"]);
  assert.deepEqual(batch.results.map(({ reasonCodes }) => reasonCodes), [
    [],
    ["INVALID_QUANTITY", "CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"],
    ["INSUFFICIENT_STOCK"],
    [],
    ["CUSTOMER_BLOCKED"],
  ]);
  assert.deepEqual(batch.exceptionWorklist.map(({ resultIndex }) => resultIndex), [4, 2, 1]);
  assert.equal(batch.summary.shipReadyCount, 2);
  assert.equal(batch.summary.exceptionCount, 3);
  // 같은 자재의 반복 주문에도 같은 스냅샷을 쓰고 호출 사이에 재고를 차감하지 않는다.
  assert.equal(provider.getAvailableQuantity("M-1"), 20);
  assert.deepEqual(parseCsvUpload(business, provider), actual);
  actual.orders[0]!.availableQuantity = 0;
  assert.deepEqual(parseCsvUpload(business, provider).orders, expected.orders);
});
