import assert from "node:assert/strict";
import test from "node:test";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { createCsvDecisionContextProvider } from "../src/csv-decision-reference.js";
import type { DecisionContextProvider } from "../src/decision-context.js";
import { parseCsvOrders, parseCsvOrdersForUpload, parseCsvUpload, preflightCsvUploadReferences } from "../src/order-csv.js";

const businessHeader = "orderId,customerId,materialId,orderQuantity";
const fullHeader = `${businessHeader},availableQuantity,customerBlocked,materialBlocked`;
const customerHeader = "customerId,customerBlocked";
const materialHeader = "materialId,materialBlocked,availableQuantity";
const noLookup: DecisionContextProvider = {
  getCustomerBlocked: () => { throw new Error("조회하면 안 됩니다"); },
  getMaterialBlocked: () => { throw new Error("조회하면 안 됩니다"); },
  getAvailableQuantity: () => { throw new Error("조회하면 안 됩니다"); },
};

test("실제 기준 CSV의 모든 누락을 모으고 수정 후 기존 전체 배치 결과로 복귀한다", () => {
  const source = `${businessHeader},estimatedAmount,dueDate,orderComment\nA,C-1,M-1,1,,,\nB,C-2,M-1,0,100,2026-10-15,고객 확인\nC,C-1,M-2,2,200,2026-10-14,"자재, 확인"\n`;
  const initialProvider = createCsvDecisionContextProvider(
    `${customerHeader}\nC-1,false`,
    `${materialHeader}\nM-1,false,20`,
  );
  const missing = preflightCsvUploadReferences(source, initialProvider);
  assert.deepEqual(missing, {
    status: "missing-references",
    missingReferences: [
      { orderIndex: 1, orderId: "B", referenceKind: "customer", identifier: "C-2" },
      { orderIndex: 2, orderId: "C", referenceKind: "material", identifier: "M-2" },
      { orderIndex: 2, orderId: "C", referenceKind: "inventory", identifier: "M-2" },
    ],
  });
  assert.equal("orders" in missing, false);
  assert.equal("upload" in missing, false);
  for (const parse of [parseCsvUpload, parseCsvOrdersForUpload]) {
    assert.throws(() => parse(source, initialProvider), /B.*고객.*C-2/);
  }
  const correctedProvider = createCsvDecisionContextProvider(
    `${customerHeader}\nC-1,false\nC-2,true`,
    `${materialHeader}\nM-1,false,20\nM-2,true,-1`,
  );
  const corrected = preflightCsvUploadReferences(source, correctedProvider);
  assert.equal(corrected.status, "ready");
  if (corrected.status !== "ready") assert.fail("수정된 기준으로 점검을 통과해야 합니다.");
  assert.deepEqual(corrected.upload, parseCsvUpload(source, correctedProvider));
  assert.equal(corrected.upload.referenceSource, "provider");
  const direct = parseCsvOrders(`${fullHeader},estimatedAmount,dueDate,orderComment\nA,C-1,M-1,1,20,false,false,,,\nB,C-2,M-1,0,20,true,false,100,2026-10-15,고객 확인\nC,C-1,M-2,2,-1,false,true,200,2026-10-14,"자재, 확인"\n`);
  assert.deepEqual(corrected.upload.orders, direct);
  const batch = analyzeOrderBatch(corrected.upload.orders);
  assert.deepEqual(batch, analyzeOrderBatch(direct));
  assert.deepEqual(batch.results.map(({ status }) => status), ["SHIP_READY", "EXCEPTION", "EXCEPTION"]);
  assert.deepEqual(batch.results.map(({ reasonCodes }) => reasonCodes), [
    [], ["INVALID_QUANTITY", "CUSTOMER_BLOCKED"], ["MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"],
  ]);
  assert.deepEqual(preflightCsvUploadReferences(source, initialProvider), missing);
});

test("세 기준을 독립 조회하고 주문 순서, 종류 순서 및 동일 주문의 중복을 보존한다", () => {
  const calls: string[] = [];
  const provider: DecisionContextProvider = {
    getCustomerBlocked: (id) => { calls.push(`customer:${id}`); return undefined; },
    getMaterialBlocked: (id) => { calls.push(`material:${id}`); return undefined; },
    getAvailableQuantity: (id) => { calls.push(`inventory:${id}`); return undefined; },
  };
  const source = `${businessHeader}\nS,C,M,1\nS,C,M,1`;
  const expected = {
    status: "missing-references",
    missingReferences: [0, 1].flatMap((orderIndex) => [
      { orderIndex, orderId: "S", referenceKind: "customer", identifier: "C" },
      { orderIndex, orderId: "S", referenceKind: "material", identifier: "M" },
      { orderIndex, orderId: "S", referenceKind: "inventory", identifier: "M" },
    ]),
  };
  const first = preflightCsvUploadReferences(source, provider);
  assert.deepEqual(first, expected);
  assert.deepEqual(calls, ["customer:C", "material:M", "inventory:M", "customer:C", "material:M", "inventory:M"]);
  const second = preflightCsvUploadReferences(source, provider);
  if (first.status !== "missing-references" || second.status !== "missing-references") assert.fail("누락 결과가 필요합니다.");
  assert.notStrictEqual(first.missingReferences, second.missingReferences);
  assert.notStrictEqual(first.missingReferences[0], second.missingReferences[0]);
  first.missingReferences[0]!.identifier = "changed";
  first.missingReferences.pop();
  assert.deepEqual(second, expected);
  assert.deepEqual(preflightCsvUploadReferences(source, provider), expected);
});

test("자재와 재고 중 하나만 없는 공급자에서도 누락 종류를 구분한다", () => {
  for (const referenceKind of ["customer", "material", "inventory"] as const) {
    const provider: DecisionContextProvider = {
      getCustomerBlocked: () => referenceKind === "customer" ? undefined : false,
      getMaterialBlocked: () => referenceKind === "material" ? undefined : false,
      getAvailableQuantity: () => referenceKind === "inventory" ? undefined : 0,
    };
    assert.deepEqual(preflightCsvUploadReferences(`${businessHeader}\nS,C,M,1`, provider), {
      status: "missing-references",
      missingReferences: [{ orderIndex: 0, orderId: "S", referenceKind, identifier: referenceKind === "customer" ? "C" : "M" }],
    });
  }
});

test("false, true 및 0·음수·소수 재고는 존재하는 기준이며 ready는 출고 판정이 아니다", () => {
  for (const availableQuantity of [0, -1, 2.5]) {
    const provider: DecisionContextProvider = {
      getCustomerBlocked: () => false,
      getMaterialBlocked: () => true,
      getAvailableQuantity: () => availableQuantity,
    };
    const source = `${businessHeader}\nS,C,M,1`;
    const result = preflightCsvUploadReferences(source, provider);
    assert.deepEqual(result, { status: "ready", upload: parseCsvUpload(source, provider) });
    if (result.status !== "ready") assert.fail("기준이 모두 존재합니다.");
    assert.equal(result.upload.orders[0]!.availableQuantity, availableQuantity);
    assert.equal(analyzeOrderBatch(result.upload.orders).results[0]!.status, "EXCEPTION");
  }
});

test("직접 판정 열은 조회 없이 기존 파싱 결과를 반환하며 빈 입력의 출처도 유지한다", () => {
  const source = `${fullHeader}\nS,UNKNOWN,UNKNOWN,1,0,false,true`;
  assert.deepEqual(preflightCsvUploadReferences(source, noLookup), {
    status: "ready", upload: { orders: parseCsvOrders(source), referenceSource: "csv" },
  });
  for (const [header, referenceSource] of [[businessHeader, "provider"], [fullHeader, "csv"]] as const) {
    assert.deepEqual(preflightCsvUploadReferences(header, noLookup), {
      status: "ready", upload: { orders: [], referenceSource },
    });
  }
});

test("모든 업무 행과 CSV 구문을 조회 전에 검증하고 기존 오류 메시지를 유지한다", () => {
  const invalidSources = [
    "",
    `${businessHeader},unknown`,
    `${businessHeader},orderId`,
    "orderId,customerId,materialId",
    `${businessHeader}\nS,C,M,1\nT,C,M`,
    `${businessHeader}\nS,C,M,1\nT, ,M,1`,
    `${businessHeader}\nS,C,M,1\nT,C,M,Infinity`,
    `${businessHeader},estimatedAmount\nS,C,M,1,\nT,C,M,1,NaN`,
    `${businessHeader}\nS,C,M,1\n"unterminated`,
    `${businessHeader}\nS,C,M,1\n"T"suffix,C,M,1`,
    `${fullHeader}\nS,C,M,1,0,FALSE,false`,
    `${fullHeader}\nS,C,M,1,,false,false`,
  ];
  for (const source of invalidSources) {
    let expected = "";
    try { parseCsvUpload(source, noLookup); } catch (error) {
      assert.ok(error instanceof Error);
      expected = error.message;
    }
    assert.notEqual(expected, "");
    assert.notEqual(expected, "조회하면 안 됩니다");
    assert.throws(() => preflightCsvUploadReferences(source, noLookup), { message: expected });
  }
  const fields = ["availableQuantity", "customerBlocked", "materialBlocked"];
  for (let mask = 1; mask < 7; mask += 1) {
    const subset = fields.filter((_, index) => (mask & (1 << index)) !== 0);
    assert.throws(() => preflightCsvUploadReferences(`${businessHeader},${subset.join(",")}`, noLookup), /필수 필드/);
  }
});

test("BOM, 인용 식별자, 내부 줄바꿈과 공백을 보존하고 정확한 원본 값으로 조회한다", () => {
  const provider = createCsvDecisionContextProvider(
    `${customerHeader}\nC,false`,
    `${materialHeader}\nM,false,1`,
  );
  const result = preflightCsvUploadReferences('\uFEFFmaterialId,orderQuantity,customerId,orderId\r\n" M ",1," c ","S,""1""\r\nnext"\r\n', provider);
  assert.deepEqual(result, {
    status: "missing-references",
    missingReferences: [
      { orderIndex: 0, orderId: 'S,"1"\r\nnext', referenceKind: "customer", identifier: " c " },
      { orderIndex: 0, orderId: 'S,"1"\r\nnext', referenceKind: "material", identifier: " M " },
      { orderIndex: 0, orderId: 'S,"1"\r\nnext', referenceKind: "inventory", identifier: " M " },
    ],
  });
});

test("공급자가 던진 오류를 누락으로 바꾸지 않고 그대로 전달한다", () => {
  for (const method of ["getCustomerBlocked", "getMaterialBlocked", "getAvailableQuantity"] as const) {
    const failure = new Error(`조회 실패: ${method}`);
    const provider: DecisionContextProvider = {
      getCustomerBlocked: () => false,
      getMaterialBlocked: () => false,
      getAvailableQuantity: () => 1,
      [method]: () => { throw failure; },
    };
    assert.throws(() => preflightCsvUploadReferences(`${businessHeader}\nS,C,M,1`, provider), (error: unknown) => error === failure);
  }
});
