import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createAppRuntimeEvidence, projectAppRuntimeBatchOutput, verifyAppRuntimeEvidence } from "../src/app-evidence.js";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { analyzeOrder, type ExceptionGuide, type ReasonCode } from "../src/order-analysis.js";

const sha = "a".repeat(40);
const purpose = "주문 데이터를 받아 출고 가능/예외를 판정하고 사유코드 반환";

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

test("App Runtime Evidence는 실제 app 실행 결과를 deterministic하게 담는다", () => {
  const first = createAppRuntimeEvidence(sha, purpose);
  const second = createAppRuntimeEvidence(sha, purpose);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  verifyAppRuntimeEvidence(first, sha);
  assert.equal(first.scenarios.length, 4);
  assert.deepEqual(first.scenarios.map(({ id, description, input }) => ({
    id, description, orderCount: input.orderCount, orderIds: input.orderIds,
  })), [
    {
      id: "all-ready", description: "모든 주문이 출고 가능한 batch",
      orderCount: 2, orderIds: ["SO-READY-1", "SO-READY-2"],
    },
    {
      id: "mixed-exceptions", description: "정상 주문과 서로 다른 예외 사유가 함께 있는 batch",
      orderCount: 4, orderIds: ["SO-READY-1", "SO-INVALID", "SO-CUSTOMER", "SO-STOCK"],
    },
    {
      id: "multiple-reasons", description: "한 주문에 여러 예외 사유가 동시에 있는 batch",
      orderCount: 1, orderIds: ["SO-MULTI"],
    },
    {
      id: "duplicate-exception-id", description: "동일 주문 ID의 예외 입력이 반복되는 batch",
      orderCount: 2, orderIds: ["SO-DUP", "SO-DUP"],
    },
  ]);

  const mixed = first.scenarios.find(({ id }) => id === "mixed-exceptions")!;
  assert.deepEqual(mixed.output.results.filter(({ status }) => status === "EXCEPTION").map(({ orderId }) => orderId), [
    "SO-INVALID",
    "SO-CUSTOMER",
    "SO-STOCK",
  ]);
  assert.equal(mixed.output.summary.exceptionCount, 3);
  assert.equal(mixed.output.summary.shipReadyCount, 1);

  assert.equal(mixed.input.orders.length, mixed.input.orderCount);
  assert.deepEqual(
    Object.keys(mixed.input.orders[0]!).sort(),
    [
      "availableQuantity",
      "customerBlocked",
      "customerId",
      "dueDate",
      "estimatedAmount",
      "materialBlocked",
      "materialId",
      "orderComment",
      "orderId",
      "orderQuantity",
    ],
  );
  assert.deepEqual(mixed.input.orders[1], {
    orderId: "SO-INVALID",
    customerId: "C-001",
    materialId: "M-001",
    orderQuantity: 0,
    availableQuantity: 20,
    customerBlocked: false,
    materialBlocked: false,
  });
  const { orderId: mixedId, availableQuantity: mixedAvailable, customerBlocked: mixedCustomerBlocked, materialBlocked: mixedMaterialBlocked, ...mixedDetails } = mixed.input.orders[0]!;
  assert.deepEqual(mixedDetails, {
    materialId: "M-001",
    orderQuantity: 10,
    customerId: "C-001",
    estimatedAmount: 1250000,
    dueDate: "2026-10-15",
    orderComment: "오전 입고 요청",
  });
  const seenReasons = new Set<ReasonCode>();
  for (const scenario of first.scenarios) {
    const full = analyzeOrderBatch(scenario.input.orders);
    assert.deepEqual(scenario.output, projectAppRuntimeBatchOutput(full));
    assert.equal(scenario.output.format, "batch-projection-v1");
    assert.equal(scenario.output.fullOutputDigest, createHash("sha256").update(JSON.stringify(full), "utf8").digest("hex"));
    assert.deepEqual(Object.keys(scenario.output).sort(), [
      "exceptionPriorities", "exceptionWorklist", "format", "fullOutputDigest", "guideTable", "results", "summary",
    ]);
    assert.deepEqual(scenario.output.summary, {
      totalCount: full.summary.totalCount,
      shipReadyCount: full.summary.shipReadyCount,
      exceptionCount: full.summary.exceptionCount,
      reasonCounts: full.summary.reasonCounts,
    });
    assert.deepEqual(scenario.output.exceptionPriorities, full.exceptionPriorities.map(({ rank, resultIndex }) => ({ rank, resultIndex })));
    assert.deepEqual(scenario.output.exceptionWorklist, full.exceptionWorklist.map(({ rank, resultIndex }) => ({ rank, resultIndex })));
    assert.equal(scenario.input.orderCount, scenario.input.orders.length);
    assert.deepEqual(scenario.input.orderIds, scenario.input.orders.map(({ orderId }) => orderId));
    assert.equal(scenario.output.results.length, scenario.input.orders.length);
    const firstSeenGuides: ExceptionGuide[] = [];
    scenario.input.orders.forEach((order, index) => {
      const result = scenario.output.results[index]!;
      const fullResult = full.results[index]!;
      const hasDetails = scenario.id === "duplicate-exception-id" ||
        (scenario.id === "mixed-exceptions" && index === 0);
      for (const key of ["estimatedAmount", "dueDate", "orderComment"] as const) {
        assert.equal(Object.prototype.hasOwnProperty.call(order, key), hasDetails);
        assert.equal(Object.prototype.hasOwnProperty.call(fullResult.orderDetails, key), hasDetails);
      }
      const { orderId, availableQuantity, customerBlocked, materialBlocked, ...orderDetails } = order;
      assert.equal(result.orderId, orderId);
      assert.deepEqual(fullResult.orderDetails, orderDetails);
      assert.notStrictEqual(fullResult.orderDetails, order);
      assert.deepEqual(Object.keys(result).sort(), ["guideRefs", "orderId", "reasonCodes", "status"]);
      const restoredGuides = result.guideRefs.map((ref) => {
        assert.ok(Number.isInteger(ref) && ref >= 0 && ref < scenario.output.guideTable.length);
        return scenario.output.guideTable[ref]!;
      });
      assert.deepEqual({ status: result.status, reasonCodes: result.reasonCodes, exceptionGuides: restoredGuides }, analyzeOrder(order));
      assert.deepEqual(restoredGuides, result.reasonCodes.map((code) => expectedGuides[code]));
      for (const guide of fullResult.exceptionGuides) {
        if (!firstSeenGuides.some((seen) => JSON.stringify(seen) === JSON.stringify(guide))) firstSeenGuides.push(guide);
      }
      for (const code of result.reasonCodes) seenReasons.add(code);
    });
    assert.deepEqual(scenario.output.guideTable, firstSeenGuides);
  }
  assert.deepEqual([...seenReasons].sort(), Object.keys(expectedGuides).sort());

  const duplicate = first.scenarios.find(({ id }) => id === "duplicate-exception-id")!;
  assert.deepEqual(duplicate.output.results.filter(({ status }) => status === "EXCEPTION").map(({ orderId }) => orderId), ["SO-DUP", "SO-DUP"]);
  assert.deepEqual(duplicate.input.orders.map(({ orderId, availableQuantity, customerBlocked, materialBlocked, ...orderDetails }) => orderDetails), [
    {
      materialId: "M-001",
      orderQuantity: 10,
      customerId: "C-001",
      estimatedAmount: 1250000,
      dueDate: "2026-10-15",
      orderComment: "오전 입고 요청",
    },
    {
      materialId: "M-002",
      orderQuantity: 5,
      customerId: "C-002",
      estimatedAmount: 625000,
      dueDate: "2026-10-16",
      orderComment: "오후 입고 요청",
    },
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= 8_192);
});

test("축약은 실제 가이드 전체 값과 반복 순서를 보존하고 각 예외 배열을 독립적으로 투영한다", () => {
  const orders = createAppRuntimeEvidence(sha, purpose).scenarios[2]!.input.orders;
  const full = analyzeOrderBatch([...orders, ...orders]);
  const guide = full.results[0]!.exceptionGuides[0]!;
  const changedGuide = { ...guide, check: "실제 출력의 다른 확인 내용" };
  full.results[0]!.exceptionGuides = [changedGuide, guide, { ...guide }, changedGuide];
  full.results[1]!.exceptionGuides = [{ ...guide }];
  full.exceptionPriorities.reverse();
  full.exceptionPriorities[0]!.rank = 7;
  full.exceptionWorklist[0]!.rank = 9;
  const snapshot = JSON.stringify(full);
  const projection = projectAppRuntimeBatchOutput(full);
  assert.equal(JSON.stringify(full), snapshot);
  assert.deepEqual(projection, projectAppRuntimeBatchOutput(full));
  assert.deepEqual(projection.guideTable, [changedGuide, guide]);
  assert.deepEqual(projection.results.map(({ guideRefs }) => guideRefs), [[0, 1, 1, 0], [1]]);
  assert.deepEqual(projection.exceptionPriorities, [{ rank: 7, resultIndex: 1 }, { rank: 1, resultIndex: 0 }]);
  assert.deepEqual(projection.exceptionWorklist, [{ rank: 9, resultIndex: 0 }, { rank: 2, resultIndex: 1 }]);
  projection.guideTable[0]!.check = "사본 수정";
  projection.results[0]!.reasonCodes.length = 0;
  projection.results[0]!.guideRefs.length = 0;
  projection.summary.reasonCounts.CUSTOMER_BLOCKED = 99;
  projection.exceptionPriorities[0]!.rank = 99;
  projection.exceptionWorklist[0]!.resultIndex = 99;
  assert.equal(JSON.stringify(full), snapshot);
});

test("생략 필드와 향후 추가 출력 필드도 전체 JSON digest에 반영한다", () => {
  const orders = createAppRuntimeEvidence(sha, purpose).scenarios[3]!.input.orders;
  const baseline = projectAppRuntimeBatchOutput(analyzeOrderBatch(orders));
  const mutations: Array<(output: ReturnType<typeof analyzeOrderBatch>) => void> = [
    (output) => { output.results[0]!.orderDetails.orderComment = "변경된 상세"; },
    (output) => { output.summary.exceptionRate = 0; },
    (output) => { output.summary.exceptionOrderIds.reverse(); output.summary.exceptionOrderIds[0] = "변경"; },
    (output) => { output.summary.topReasonCodes.length = 0; },
    (output) => { output.exceptionPriorities[0]!.basis.estimatedAmount = 1; },
    (output) => { output.exceptionWorklist[0]!.exceptionGuides[0]!.action = "변경된 처리"; },
    (output) => { Object.assign(output, { futureOutput: { value: "추가" } }); },
    (output) => { Object.assign(output.results[0]!, { futureResult: "추가" }); },
  ];
  for (const mutate of mutations) {
    const full = analyzeOrderBatch(orders);
    mutate(full);
    const projection = projectAppRuntimeBatchOutput(full);
    assert.equal(projection.fullOutputDigest, createHash("sha256").update(JSON.stringify(full), "utf8").digest("hex"));
    assert.notEqual(projection.fullOutputDigest, baseline.fullOutputDigest);
    const { fullOutputDigest, ...visible } = projection;
    const { fullOutputDigest: baselineDigest, ...baselineVisible } = baseline;
    assert.deepEqual(visible, baselineVisible);
  }
});

test("App Runtime Evidence는 source SHA 변조를 거부한다", () => {
  const evidence = createAppRuntimeEvidence(sha, purpose);
  assert.throws(() => verifyAppRuntimeEvidence(evidence, "b".repeat(40)));
});

test("App Runtime Evidence는 가이드 변조 및 생략과 실제 출력 변조를 거부한다", () => {
  const mutations: Array<(evidence: ReturnType<typeof createAppRuntimeEvidence>) => void> = [
    (evidence) => { evidence.scenarios[1]!.output.guideTable[0]!.check = "변조"; },
    (evidence) => { evidence.scenarios[1]!.output.guideTable[0]!.action = "변조"; },
    (evidence) => { evidence.scenarios[1]!.output.guideTable[0]!.reasonCode = "MATERIAL_BLOCKED"; },
    (evidence) => { evidence.scenarios[1]!.output.results[1]!.guideRefs.length = 0; },
    (evidence) => { evidence.scenarios[2]!.output.results[0]!.guideRefs.reverse(); },
    (evidence) => { evidence.scenarios[1]!.output.results[1]!.reasonCodes.length = 0; },
    (evidence) => { evidence.scenarios[1]!.output.summary.exceptionCount = 0; },
    (evidence) => { evidence.scenarios[3]!.output.exceptionPriorities[0]!.rank = 99; },
    (evidence) => { Object.assign(evidence.scenarios[1]!.input.orders[0]!, { orderComment: "변조" }); },
    (evidence) => { evidence.scenarios[1]!.output.fullOutputDigest = "0".repeat(64); },
    (evidence) => { Object.assign(evidence.scenarios[1]!.output, { format: "batch-projection-v2" }); },
    (evidence) => { evidence.scenarios[1]!.output.guideTable.length = 0; },
    (evidence) => { evidence.scenarios[1]!.output.results[1]!.guideRefs[0] = 99; },
    (evidence) => { evidence.scenarios[1]!.output.results[0]!.status = "EXCEPTION"; },
    (evidence) => { evidence.scenarios[3]!.output.exceptionPriorities[0]!.resultIndex = 1; },
    (evidence) => { evidence.scenarios[3]!.output.exceptionWorklist[0]!.rank = 99; },
    (evidence) => { evidence.scenarios[3]!.output.exceptionWorklist[0]!.resultIndex = 1; },
    (evidence) => { evidence.scenarios[3]!.output.exceptionWorklist.reverse(); },
    (evidence) => { evidence.scenarios[3]!.output.exceptionWorklist.length = 0; },
  ];
  for (const mutate of mutations) {
    const evidence = createAppRuntimeEvidence(sha, purpose);
    mutate(evidence);
    assert.throws(() => verifyAppRuntimeEvidence(evidence, sha), /does not match deterministic app execution/);
  }
  const first = createAppRuntimeEvidence(sha, purpose);
  const second = createAppRuntimeEvidence(sha, purpose);
  first.scenarios[1]!.output.guideTable[0]!.check = "변조";
  assert.deepEqual(createAppRuntimeEvidence(sha, purpose), second);
  verifyAppRuntimeEvidence(second, sha);
});

test("App Runtime Evidence는 UTF-8 8192 bytes까지 허용하고 초과를 거부한다", () => {
  const baseBytes = Buffer.byteLength(JSON.stringify(createAppRuntimeEvidence(sha, purpose)), "utf8");
  const remaining = 8_192 - baseBytes;
  assert.ok(remaining >= 3);
  const boundaryPurpose = purpose + "가".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
  const boundary = createAppRuntimeEvidence(sha, boundaryPurpose);
  assert.equal(Buffer.byteLength(JSON.stringify(boundary), "utf8"), 8_192);
  assert.ok(JSON.stringify(boundary).length < 8_192);
  verifyAppRuntimeEvidence(boundary, sha);

  const over = createAppRuntimeEvidence(sha, boundaryPurpose + "x");
  assert.equal(Buffer.byteLength(JSON.stringify(over), "utf8"), 8_193);
  assert.ok(JSON.stringify(over).length < 8_192);
  assert.throws(() => verifyAppRuntimeEvidence(over, sha), /exceeds bounded evidence item budget/);

  over.scenarios[1]!.output.guideTable[0]!.check = "변조";
  assert.throws(() => verifyAppRuntimeEvidence(over, sha), /does not match deterministic app execution/);
  assert.throws(() => verifyAppRuntimeEvidence(over, "b".repeat(40)), /invalid App Runtime Evidence identity/);
});
