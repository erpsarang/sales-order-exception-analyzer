import assert from "node:assert/strict";
import test from "node:test";
import { analyzeOrderBatch } from "../src/batch-order-analysis.js";
import { analyzeOrder, type OrderInput } from "../src/order-analysis.js";

const normalOrder: Readonly<OrderInput> = Object.freeze({
  orderId: "SO-003",
  customerId: "C-001",
  materialId: "M-001",
  orderQuantity: 10,
  availableQuantity: 20,
  customerBlocked: false,
  materialBlocked: false,
});
const exceptionOrder: Readonly<OrderInput> = Object.freeze({
  ...normalOrder,
  orderId: "SO-001",
  orderQuantity: 0,
  availableQuantity: -1,
  customerBlocked: true,
  materialBlocked: true,
});

type ReasonCode = ReturnType<typeof analyzeOrder>["reasonCodes"][number];
const reasonCodeOrder: readonly ReasonCode[] = [
  "INVALID_QUANTITY",
  "CUSTOMER_BLOCKED",
  "MATERIAL_BLOCKED",
  "INSUFFICIENT_STOCK",
];
const zeroReasonCounts = (): Record<ReasonCode, number> => ({
  INVALID_QUANTITY: 0,
  CUSTOMER_BLOCKED: 0,
  MATERIAL_BLOCKED: 0,
  INSUFFICIENT_STOCK: 0,
});

const cases = [
  { name: "정상 주문만", orders: [normalOrder, { ...normalOrder, availableQuantity: 10 }], ready: 2, exceptions: 0, exceptionRate: 0, exceptionOrderIds: [] },
  { name: "예외 주문만", orders: [exceptionOrder, { ...normalOrder, availableQuantity: 0 }], ready: 0, exceptions: 2, exceptionRate: 1, exceptionOrderIds: ["SO-001", "SO-003"] },
  { name: "정상 및 예외 주문 혼합", orders: [normalOrder, exceptionOrder, { ...normalOrder, orderId: "SO-002" }], ready: 2, exceptions: 1, exceptionRate: 1 / 3, exceptionOrderIds: ["SO-001"] },
  { name: "네 주문 중 한 주문만 예외", orders: [normalOrder, exceptionOrder, { ...normalOrder, orderId: "SO-002" }, normalOrder], ready: 3, exceptions: 1, exceptionRate: 0.25, exceptionOrderIds: ["SO-001"] },
  { name: "빈 배열", orders: [], ready: 0, exceptions: 0, exceptionRate: 0, exceptionOrderIds: [] },
];

for (const { name, orders, ready, exceptions, exceptionRate, exceptionOrderIds } of cases) {
  test(`${name}: 단일 주문과 동일한 판정 및 정확한 집계를 반환한다`, () => {
    const { results, summary } = analyzeOrderBatch(orders);
    const expectedResults = orders.map((order) => ({
      orderId: order.orderId,
      orderDetails: {
        materialId: order.materialId,
        orderQuantity: order.orderQuantity,
        customerId: order.customerId,
      },
      ...analyzeOrder(order),
    }));
    assert.deepEqual(results, expectedResults);
    const reasonCounts = zeroReasonCounts();
    for (const code of reasonCodeOrder) {
      reasonCounts[code] = expectedResults.filter((result) =>
        result.status === "EXCEPTION" && result.reasonCodes.includes(code),
      ).length;
    }
    const topReasonCodes = reasonCodeOrder.filter((code) =>
      reasonCounts[code] > 0 && reasonCodeOrder.every((other) =>
        reasonCounts[code] >= reasonCounts[other],
      ),
    );
    assert.deepEqual(summary, {
      totalCount: orders.length,
      shipReadyCount: ready,
      exceptionCount: exceptions,
      exceptionRate,
      exceptionOrderIds,
      reasonCounts,
      topReasonCodes,
    });
    assert.equal(typeof summary.exceptionRate, "number");
    assert.ok(Number.isFinite(summary.exceptionRate));
    assert.equal(summary.shipReadyCount + summary.exceptionCount, summary.totalCount);
  });
}

const singleReasonCases: { code: ReasonCode; overrides: Partial<OrderInput> }[] = [
  { code: "INVALID_QUANTITY", overrides: { orderQuantity: 0 } },
  { code: "CUSTOMER_BLOCKED", overrides: { customerBlocked: true } },
  { code: "MATERIAL_BLOCKED", overrides: { materialBlocked: true } },
  { code: "INSUFFICIENT_STOCK", overrides: { availableQuantity: 0 } },
];

for (const { code, overrides } of singleReasonCases) {
  test(`${code} 사유를 집계하고 단독 최다 사유로 반환한다`, () => {
    const { summary } = analyzeOrderBatch([
      normalOrder,
      { ...normalOrder, ...overrides },
    ]);
    assert.deepEqual(summary, {
      totalCount: 2,
      shipReadyCount: 1,
      exceptionCount: 1,
      exceptionRate: 0.5,
      exceptionOrderIds: ["SO-003"],
      reasonCounts: { ...zeroReasonCounts(), [code]: 1 },
      topReasonCodes: [code],
    });
  });
}

test("한 예외 주문의 복수 사유를 각각 집계하고 동률 사유를 고정 순서로 반환한다", () => {
  const { summary } = analyzeOrderBatch([
    { ...normalOrder, customerBlocked: true, materialBlocked: true, availableQuantity: 0 },
  ]);
  assert.deepEqual(summary, {
    totalCount: 1,
    shipReadyCount: 0,
    exceptionCount: 1,
    exceptionRate: 1,
    exceptionOrderIds: ["SO-003"],
    reasonCounts: {
      INVALID_QUANTITY: 0,
      CUSTOMER_BLOCKED: 1,
      MATERIAL_BLOCKED: 1,
      INSUFFICIENT_STOCK: 1,
    },
    topReasonCodes: ["CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"],
  });
});

test("네 사유의 동률은 입력 순서와 관계없이 지정된 순서로 반환한다", () => {
  const orders = [...singleReasonCases].reverse().map(({ overrides }) => ({
    ...normalOrder,
    ...overrides,
  }));
  assert.deepEqual(analyzeOrderBatch(orders).summary, {
    totalCount: 4,
    shipReadyCount: 0,
    exceptionCount: 4,
    exceptionRate: 1,
    exceptionOrderIds: ["SO-003", "SO-003", "SO-003", "SO-003"],
    reasonCounts: {
      INVALID_QUANTITY: 1,
      CUSTOMER_BLOCKED: 1,
      MATERIAL_BLOCKED: 1,
      INSUFFICIENT_STOCK: 1,
    },
    topReasonCodes: ["INVALID_QUANTITY", "CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"],
  });
});

test("최대 건수보다 적은 양수 사유는 최다 사유에서 제외한다", () => {
  const { summary } = analyzeOrderBatch([
    { ...normalOrder, customerBlocked: true, materialBlocked: true },
    { ...normalOrder, customerBlocked: true },
    { ...normalOrder, availableQuantity: 0 },
  ]);
  assert.deepEqual(summary.reasonCounts, {
    INVALID_QUANTITY: 0,
    CUSTOMER_BLOCKED: 2,
    MATERIAL_BLOCKED: 1,
    INSUFFICIENT_STOCK: 1,
  });
  assert.deepEqual(summary.topReasonCodes, ["CUSTOMER_BLOCKED"]);
});

test("빈 입력과 정상 주문만 있는 입력은 모든 사유가 0건이며 최다 사유가 없다", () => {
  for (const orders of [[], [normalOrder, normalOrder]]) {
    const { summary } = analyzeOrderBatch(orders);
    assert.deepEqual(summary, {
      totalCount: orders.length,
      shipReadyCount: orders.length,
      exceptionCount: 0,
      exceptionRate: 0,
      exceptionOrderIds: [],
      reasonCounts: zeroReasonCounts(),
      topReasonCodes: [],
    });
  }
});

test("입력 순서와 중복 주문을 보존한다", () => {
  const orders = [normalOrder, exceptionOrder, { ...normalOrder, orderId: "SO-002" }, normalOrder];
  assert.deepEqual(analyzeOrderBatch(orders).results.map((result) => result.orderId), [
    "SO-003", "SO-001", "SO-002", "SO-003",
  ]);
});

test("예외 ID만 입력 순서대로 반환하며 중복 ID의 정상 및 예외 항목을 구분한다", () => {
  const blockedOrder = Object.freeze({ ...normalOrder, customerBlocked: true });
  const orders = Object.freeze([
    normalOrder,
    blockedOrder,
    exceptionOrder,
    { ...normalOrder, orderId: "SO-002" },
    blockedOrder,
    { ...normalOrder, orderId: "SO-001" },
    { ...normalOrder, orderId: "SO-002", availableQuantity: 0 },
  ].map((order) => Object.freeze(order)));
  const snapshot = orders.map((order) => ({ ...order }));
  const { results, summary } = analyzeOrderBatch(orders);
  assert.deepEqual(results, orders.map((order) => ({
    orderId: order.orderId,
    orderDetails: {
      materialId: order.materialId,
      orderQuantity: order.orderQuantity,
      customerId: order.customerId,
    },
    ...analyzeOrder(order),
  })));
  assert.deepEqual(summary.exceptionOrderIds, ["SO-003", "SO-001", "SO-003", "SO-002"]);
  assert.equal(summary.exceptionOrderIds.length, summary.exceptionCount);
  assert.deepEqual(orders, snapshot);
});

test("동일 객체 및 동일 주문 ID의 중복 입력을 항목마다 집계한다", () => {
  const blockedOrder = { ...normalOrder, customerBlocked: true, materialBlocked: true };
  const orders = [blockedOrder, blockedOrder, { ...blockedOrder }];
  const { results, summary } = analyzeOrderBatch(orders);
  assert.deepEqual(results, orders.map((order) => ({
    orderId: order.orderId,
    orderDetails: {
      materialId: order.materialId,
      orderQuantity: order.orderQuantity,
      customerId: order.customerId,
    },
    ...analyzeOrder(order),
  })));
  assert.deepEqual(summary, {
    totalCount: 3,
    shipReadyCount: 0,
    exceptionCount: 3,
    exceptionRate: 1,
    exceptionOrderIds: ["SO-003", "SO-003", "SO-003"],
    reasonCounts: {
      INVALID_QUANTITY: 0,
      CUSTOMER_BLOCKED: 3,
      MATERIAL_BLOCKED: 3,
      INSUFFICIENT_STOCK: 0,
    },
    topReasonCodes: ["CUSTOMER_BLOCKED", "MATERIAL_BLOCKED"],
  });
});

test("읽기 전용 입력 배열과 주문 객체를 변경하지 않고 반복 호출 결과가 동일하다", () => {
  const orders = Object.freeze([normalOrder, exceptionOrder]);
  const snapshot = orders.map((order) => ({ ...order }));
  const first = analyzeOrderBatch(orders);
  assert.deepEqual(analyzeOrderBatch(orders), first);
  assert.deepEqual(orders, snapshot);
  first.summary.exceptionOrderIds[0] = "CHANGED";
  first.summary.exceptionOrderIds.push("EXTRA");
  assert.deepEqual(first.results.map((result) => result.orderId), ["SO-003", "SO-001"]);
  assert.deepEqual(analyzeOrderBatch(orders).summary.exceptionOrderIds, ["SO-001"]);
  first.results[1]!.reasonCodes.length = 0;
  first.results.reverse();
  assert.deepEqual(analyzeOrderBatch(orders).results, orders.map((order) => ({
    orderId: order.orderId,
    orderDetails: {
      materialId: order.materialId,
      orderQuantity: order.orderQuantity,
      customerId: order.customerId,
    },
    ...analyzeOrder(order),
  })));
  assert.deepEqual(orders, snapshot);
});

test("집계 객체와 최다 사유 배열은 호출마다 독립적이다", () => {
  const orders = [{ ...normalOrder, customerBlocked: true }];
  const first = analyzeOrderBatch(orders);
  const second = analyzeOrderBatch(orders);
  assert.notStrictEqual(first.summary.reasonCounts, second.summary.reasonCounts);
  assert.notStrictEqual(first.summary.topReasonCodes, second.summary.topReasonCodes);
  assert.notStrictEqual(first.summary.exceptionOrderIds, second.summary.exceptionOrderIds);
  first.summary.reasonCounts.CUSTOMER_BLOCKED = 99;
  first.summary.reasonCounts.INVALID_QUANTITY = 10;
  first.summary.topReasonCodes.length = 0;
  first.summary.exceptionOrderIds.length = 0;
  const expectedSummary = {
    totalCount: 1,
    shipReadyCount: 0,
    exceptionCount: 1,
    exceptionRate: 1,
    exceptionOrderIds: ["SO-003"],
    reasonCounts: { ...zeroReasonCounts(), CUSTOMER_BLOCKED: 1 },
    topReasonCodes: ["CUSTOMER_BLOCKED"],
  };
  assert.deepEqual(second.summary, expectedSummary);
  assert.deepEqual(analyzeOrderBatch(orders).summary, expectedSummary);
  assert.deepEqual(analyzeOrderBatch([]).summary.reasonCounts, zeroReasonCounts());
  assert.deepEqual(analyzeOrderBatch([normalOrder]).summary.topReasonCodes, []);
  assert.deepEqual(second.summary, expectedSummary);
});

test("빈 입력과 정상 입력의 빈 예외 ID 배열도 호출마다 독립적이다", () => {
  const emptyFirst = analyzeOrderBatch([]);
  const emptySecond = analyzeOrderBatch([]);
  const normalFirst = analyzeOrderBatch([normalOrder]);
  const normalSecond = analyzeOrderBatch([normalOrder]);
  const batches = [emptyFirst, emptySecond, normalFirst, normalSecond];
  for (const [index, batch] of batches.entries()) {
    assert.deepEqual(batch.summary.exceptionOrderIds, []);
    for (const other of batches.slice(index + 1)) {
      assert.notStrictEqual(batch.summary.exceptionOrderIds, other.summary.exceptionOrderIds);
    }
  }
  emptyFirst.summary.exceptionOrderIds.push("EMPTY-MUTATION");
  normalFirst.summary.exceptionOrderIds.push("NORMAL-MUTATION");
  assert.deepEqual(emptySecond.summary.exceptionOrderIds, []);
  assert.deepEqual(normalSecond.summary.exceptionOrderIds, []);
  assert.deepEqual(analyzeOrderBatch([]).summary.exceptionOrderIds, []);
  assert.deepEqual(analyzeOrderBatch([normalOrder]).summary.exceptionOrderIds, []);
});

test("여섯 업무 상세 값을 보존하며 중복 ID도 입력 항목별로 구분한다", () => {
  const orders = Object.freeze([
    Object.freeze({
      ...normalOrder,
      estimatedAmount: 1250000,
      dueDate: "2026-10-15",
      orderComment: "오전 입고 요청",
    }),
    Object.freeze({
      ...normalOrder,
      materialId: "M-002",
      orderQuantity: 5,
      customerId: "C-002",
      estimatedAmount: 625000,
      dueDate: "2026-10-16",
      orderComment: "오후 입고 요청",
      customerBlocked: true,
    }),
  ]);
  const snapshot = orders.map((order) => ({ ...order }));
  const { results, summary } = analyzeOrderBatch(orders);
  assert.deepEqual(results, [
    {
      orderId: "SO-003",
      orderDetails: {
        materialId: "M-001",
        orderQuantity: 10,
        customerId: "C-001",
        estimatedAmount: 1250000,
        dueDate: "2026-10-15",
        orderComment: "오전 입고 요청",
      },
      status: "SHIP_READY",
      reasonCodes: [],
      exceptionGuides: [],
    },
    {
      orderId: "SO-003",
      orderDetails: {
        materialId: "M-002",
        orderQuantity: 5,
        customerId: "C-002",
        estimatedAmount: 625000,
        dueDate: "2026-10-16",
        orderComment: "오후 입고 요청",
      },
      status: "EXCEPTION",
      reasonCodes: ["CUSTOMER_BLOCKED"],
      exceptionGuides: [{
        reasonCode: "CUSTOMER_BLOCKED",
        check: "고객 차단 사유와 해제 요건 확인",
        action: "해제 가능 여부 확인 후 주문 재분석",
      }],
    },
  ]);
  assert.deepEqual(summary.exceptionOrderIds, ["SO-003"]);
  assert.deepEqual(orders, snapshot);
});

test("선택 상세 필드가 없는 기존 입력과 일부만 있는 입력을 지원한다", () => {
  const optionalDetails = [
    {},
    { estimatedAmount: 0 },
    { dueDate: "2026-10-15" },
    { orderComment: "" },
  ];
  for (const details of optionalDetails) {
    const order = { ...normalOrder, ...details };
    const { results } = analyzeOrderBatch([order]);
    assert.deepEqual(results[0]!.orderDetails, {
      materialId: "M-001",
      orderQuantity: 10,
      customerId: "C-001",
      ...details,
    });
    for (const key of ["estimatedAmount", "dueDate", "orderComment"] as const) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(results[0]!.orderDetails, key),
        Object.prototype.hasOwnProperty.call(details, key),
      );
    }
  }
});

test("선택 상세 값의 유무와 값은 단일 주문 판정 및 배치 집계를 바꾸지 않는다", () => {
  const orders = [
    normalOrder,
    ...singleReasonCases.map(({ overrides }) => ({ ...normalOrder, ...overrides })),
    exceptionOrder,
  ];
  const baseline = analyzeOrderBatch(orders);
  const variants = [
    { estimatedAmount: 1250000, dueDate: "2026-10-15", orderComment: "오전 입고 요청" },
    { estimatedAmount: 0, dueDate: "", orderComment: "" },
    { estimatedAmount: -1, dueDate: "날짜 미정", orderComment: "  확인\n요청  " },
  ];
  for (const details of variants) {
    const enriched = orders.map((order) => ({ ...order, ...details }));
    const batch = analyzeOrderBatch(enriched);
    assert.deepEqual(batch.summary, baseline.summary);
    enriched.forEach((order, index) => {
      const expectedAnalysis = analyzeOrder(orders[index]!);
      assert.deepEqual(analyzeOrder(order), expectedAnalysis);
      const { orderId, orderDetails, ...analysis } = batch.results[index]!;
      assert.equal(orderId, orders[index]!.orderId);
      assert.deepEqual(analysis, expectedAnalysis);
      assert.equal(orderDetails.estimatedAmount, details.estimatedAmount);
      assert.equal(orderDetails.dueDate, details.dueDate);
      assert.equal(orderDetails.orderComment, details.orderComment);
    });
  }
});

test("상세 사본은 입력, 중복 항목 및 반복 호출 사이에서 독립적이다", () => {
  const order = {
    ...normalOrder,
    estimatedAmount: 1250000,
    dueDate: "2026-10-15",
    orderComment: "오전 입고 요청",
  };
  const snapshot = { ...order };
  const orders = [order, order, { ...order }];
  const first = analyzeOrderBatch(orders);
  const second = analyzeOrderBatch(orders);
  const expectedDetails = {
    materialId: "M-001",
    orderQuantity: 10,
    customerId: "C-001",
    estimatedAmount: 1250000,
    dueDate: "2026-10-15",
    orderComment: "오전 입고 요청",
  };
  const copies = [...first.results, ...second.results].map(({ orderDetails }) => orderDetails);
  copies.forEach((details, index) => {
    for (const input of orders) assert.notStrictEqual(details, input);
    for (const other of copies.slice(index + 1)) assert.notStrictEqual(details, other);
  });
  Object.assign(first.results[0]!.orderDetails, {
    materialId: "CHANGED",
    orderQuantity: 99,
    customerId: "CHANGED",
    estimatedAmount: 1,
    dueDate: "2027-01-01",
    orderComment: "수정",
  });
  assert.deepEqual(order, snapshot);
  assert.deepEqual(orders[2], snapshot);
  for (const details of copies.slice(1)) assert.deepEqual(details, expectedDetails);
  assert.deepEqual(analyzeOrderBatch(orders), second);

  Object.assign(order, {
    materialId: "INPUT-CHANGED",
    orderQuantity: 3,
    customerId: "INPUT-CHANGED",
    estimatedAmount: 2,
    dueDate: "2027-02-01",
    orderComment: "입력 수정",
  });
  for (const details of copies.slice(1)) assert.deepEqual(details, expectedDetails);
});

test("예외 우선순위는 납기, 금액, 입력 위치 순이며 기존 결과와 집계를 보존한다", () => {
  const details: Partial<OrderInput>[] = [
    { estimatedAmount: 1000000 },
    { dueDate: "2026-10-16", estimatedAmount: 999999 },
    { dueDate: "2026-10-15", estimatedAmount: 10 },
    { dueDate: "2026-10-15", estimatedAmount: 100 },
    { dueDate: "2026-10-15" },
    { dueDate: "2026-10-15", estimatedAmount: 0 },
    { dueDate: "2026-10-15", estimatedAmount: 100 },
    { dueDate: "2026-10-14" },
    {},
    { dueDate: "미정", estimatedAmount: 0 },
  ];
  const orders = Object.freeze([
    Object.freeze({ ...normalOrder, dueDate: "0001-01-01", estimatedAmount: Number.MAX_VALUE }),
    ...details.map((detail, index) => Object.freeze({ ...exceptionOrder, orderId: `P-${index}`, ...detail })),
  ]);
  const snapshot = orders.map((order) => ({ ...order }));
  const batch = analyzeOrderBatch(orders);
  const expectedIndices = [8, 4, 7, 3, 6, 5, 2, 1, 10, 9];
  const expectedBases = [
    { dueDate: "2026-10-14", estimatedAmount: null },
    { dueDate: "2026-10-15", estimatedAmount: 100 },
    { dueDate: "2026-10-15", estimatedAmount: 100 },
    { dueDate: "2026-10-15", estimatedAmount: 10 },
    { dueDate: "2026-10-15", estimatedAmount: 0 },
    { dueDate: "2026-10-15", estimatedAmount: null },
    { dueDate: "2026-10-16", estimatedAmount: 999999 },
    { dueDate: null, estimatedAmount: 1000000 },
    { dueDate: null, estimatedAmount: 0 },
    { dueDate: null, estimatedAmount: null },
  ];
  assert.deepEqual(batch.exceptionPriorities, expectedIndices.map((resultIndex, index) => ({
    rank: index + 1,
    resultIndex,
    orderId: orders[resultIndex]!.orderId,
    basis: expectedBases[index],
  })));
  assert.deepEqual(batch.results, orders.map((order) => {
    const { orderId, availableQuantity, customerBlocked, materialBlocked, ...orderDetails } = order;
    return { orderId, orderDetails, ...analyzeOrder(order) };
  }));
  const baseline = analyzeOrderBatch([normalOrder, ...details.map((_, index) => ({ ...exceptionOrder, orderId: `P-${index}` }))]);
  assert.deepEqual(batch.summary, baseline.summary);
  assert.deepEqual(orders, snapshot);
  assert.deepEqual(analyzeOrderBatch(orders), batch);
});

test("납기는 실제 YYYY-MM-DD와 연도 경계를 검증하고 원래 상세 값을 보존한다", () => {
  const validDates = ["0001-01-01", "0096-02-29", "0400-02-29", "2000-02-29", "2024-02-29", "2026-04-30", "9999-12-31"];
  const invalidDates: unknown[] = [
    undefined, null, 20261015, false, "", "미정", "0000-01-01", "10000-01-01",
    "0100-02-29", "1900-02-29", "2100-02-29", "2026-02-29", "2024-02-30",
    "2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31", "2026-01-32",
    "2026-00-01", "2026-13-01", "2026-01-00", "2026-1-01", "2026-01-1",
    " 2026-01-01", "2026-01-01 ", "2026-01-01\n", "2026/01/01",
    "2026-01-01T00:00:00Z", "+026-01-01",
  ];
  for (const dueDate of [...validDates, ...invalidDates]) {
    // 런타임 무효 타입은 입력 계약을 바꾸지 않고 경계 검증용으로만 전달한다.
    const order = { ...exceptionOrder, dueDate } as unknown as OrderInput;
    const batch = analyzeOrderBatch([order]);
    const expectedDate = typeof dueDate === "string" && validDates.includes(dueDate) ? dueDate : null;
    assert.deepEqual(batch.exceptionPriorities, [{
      rank: 1, resultIndex: 0, orderId: order.orderId,
      basis: { dueDate: expectedDate, estimatedAmount: null },
    }]);
    assert.equal(batch.results[0]!.orderDetails.dueDate, dueDate);
    assert.deepEqual(batch.results[0]!.reasonCodes, analyzeOrder(order).reasonCodes);
  }
});

test("금액은 유한한 비음수 숫자만 인정하고 누락 및 무효 값은 null로 반환한다", () => {
  const validAmounts = [0, -0, 0.5, Number.MIN_VALUE, Number.MAX_VALUE];
  const invalidAmounts: unknown[] = [undefined, null, -1, -0.5, NaN, Infinity, -Infinity, "0", "100", false, ""];
  for (const estimatedAmount of [...validAmounts, ...invalidAmounts]) {
    const order = { ...exceptionOrder, estimatedAmount } as unknown as OrderInput;
    const batch = analyzeOrderBatch([order]);
    const expectedAmount = typeof estimatedAmount === "number" && validAmounts.includes(estimatedAmount) ? estimatedAmount : null;
    assert.deepEqual(batch.exceptionPriorities, [{
      rank: 1, resultIndex: 0, orderId: order.orderId,
      basis: { dueDate: null, estimatedAmount: expectedAmount },
    }]);
    assert.equal(batch.results[0]!.orderDetails.estimatedAmount, estimatedAmount);
  }
  const orders = [
    { ...exceptionOrder, dueDate: "미정", estimatedAmount: NaN },
    { ...exceptionOrder },
    { ...exceptionOrder, dueDate: "2026-02-30", estimatedAmount: -1 },
    { ...exceptionOrder, estimatedAmount: 0 },
    { ...exceptionOrder, estimatedAmount: 0.5 },
  ];
  const batch = analyzeOrderBatch(orders);
  assert.deepEqual(batch.exceptionPriorities.map(({ resultIndex }) => resultIndex), [4, 3, 0, 1, 2]);
  assert.deepEqual(batch.exceptionPriorities.slice(2).map(({ basis }) => basis), [
    { dueDate: null, estimatedAmount: null },
    { dueDate: null, estimatedAmount: null },
    { dueDate: null, estimatedAmount: null },
  ]);
});

test("동일 ID와 동일 객체의 예외 항목은 원래 결과 인덱스로 각각 연결된다", () => {
  const shared = Object.freeze({ ...exceptionOrder, dueDate: "2026-10-16", estimatedAmount: 10 });
  const orders = Object.freeze([
    shared,
    Object.freeze({ ...normalOrder, orderId: shared.orderId, dueDate: "0001-01-01" }),
    Object.freeze({ ...shared, dueDate: "2026-10-15" }),
    shared,
    Object.freeze({ ...shared }),
  ]);
  const batch = analyzeOrderBatch(orders);
  assert.deepEqual(batch.exceptionPriorities.map(({ rank, resultIndex, orderId }) => ({ rank, resultIndex, orderId })), [
    { rank: 1, resultIndex: 2, orderId: "SO-001" },
    { rank: 2, resultIndex: 0, orderId: "SO-001" },
    { rank: 3, resultIndex: 3, orderId: "SO-001" },
    { rank: 4, resultIndex: 4, orderId: "SO-001" },
  ]);
  for (const priority of batch.exceptionPriorities) {
    const result = batch.results[priority.resultIndex]!;
    assert.equal(result.status, "EXCEPTION");
    assert.equal(priority.orderId, result.orderId);
    assert.deepEqual(priority.basis, {
      dueDate: result.orderDetails.dueDate,
      estimatedAmount: result.orderDetails.estimatedAmount,
    });
  }
  assert.deepEqual(analyzeOrderBatch(orders), batch);
});

test("우선순위와 basis는 입력, 상세정보, 중복 항목 및 호출 사이에서 독립적이다", () => {
  const order = { ...exceptionOrder, dueDate: "2026-10-15", estimatedAmount: 100 };
  const orders = [order, order, { ...order }];
  const snapshot = orders.map((input) => ({ ...input }));
  const first = analyzeOrderBatch(orders);
  const second = analyzeOrderBatch(orders);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first.exceptionPriorities, second.exceptionPriorities);
  const priorities = [...first.exceptionPriorities, ...second.exceptionPriorities];
  priorities.forEach((priority, index) => {
    for (const other of priorities.slice(index + 1)) {
      assert.notStrictEqual(priority, other);
      assert.notStrictEqual(priority.basis, other.basis);
    }
    for (const input of orders) assert.notStrictEqual(priority.basis, input);
    for (const result of [...first.results, ...second.results]) {
      assert.notStrictEqual(priority.basis, result.orderDetails);
    }
  });
  first.exceptionPriorities[0]!.basis.dueDate = null;
  first.exceptionPriorities[0]!.basis.estimatedAmount = 1;
  first.exceptionPriorities[0]!.orderId = "CHANGED";
  first.exceptionPriorities[0]!.resultIndex = 99;
  first.exceptionPriorities[0]!.rank = 99;
  assert.deepEqual(first.results, second.results);
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(orders, snapshot);
  for (const priority of priorities.slice(1)) {
    assert.deepEqual(priority.basis, { dueDate: "2026-10-15", estimatedAmount: 100 });
  }
  first.exceptionPriorities.reverse();
  first.exceptionPriorities.length = 0;
  assert.deepEqual(analyzeOrderBatch(orders), second);
  first.results[1]!.orderDetails.dueDate = "2027-01-01";
  first.results[1]!.orderDetails.estimatedAmount = 999;
  Object.assign(order, { dueDate: "2028-01-01", estimatedAmount: 0 });
  for (const priority of priorities.slice(1)) {
    assert.deepEqual(priority.basis, { dueDate: "2026-10-15", estimatedAmount: 100 });
  }
});

test("빈 입력과 정상 주문만 있는 입력의 우선순위 배열은 비어 있고 호출마다 독립적이다", () => {
  const batches = [
    analyzeOrderBatch([]),
    analyzeOrderBatch([]),
    analyzeOrderBatch([normalOrder]),
    analyzeOrderBatch([{ ...normalOrder, dueDate: "0001-01-01", estimatedAmount: Number.MAX_VALUE }]),
  ];
  batches.forEach((batch, index) => {
    assert.deepEqual(batch.exceptionPriorities, []);
    for (const other of batches.slice(index + 1)) {
      assert.notStrictEqual(batch.exceptionPriorities, other.exceptionPriorities);
    }
  });
  batches[0]!.exceptionPriorities.push({
    rank: 1, resultIndex: 0, orderId: "CHANGED",
    basis: { dueDate: null, estimatedAmount: null },
  });
  for (const batch of batches.slice(1)) assert.deepEqual(batch.exceptionPriorities, []);
  assert.deepEqual(analyzeOrderBatch([]).exceptionPriorities, []);
  assert.deepEqual(analyzeOrderBatch([normalOrder]).exceptionPriorities, []);
});

test("배치는 모든 사유의 전체 가이드를 단일 주문 결과와 동일하게 전달한다", () => {
  const orders = [
    normalOrder,
    ...singleReasonCases.map(({ overrides }) => ({ ...normalOrder, ...overrides })),
    exceptionOrder,
  ];
  const batch = analyzeOrderBatch(orders);
  orders.forEach((order, index) => {
    const result = batch.results[index]!;
    const expected = analyzeOrder(order);
    assert.deepEqual(result.exceptionGuides, expected.exceptionGuides);
    assert.deepEqual(result.exceptionGuides.map(({ reasonCode }) => reasonCode), result.reasonCodes);
    assert.equal(result.exceptionGuides.length, result.reasonCodes.length);
    assert.notStrictEqual(result.exceptionGuides, expected.exceptionGuides);
    result.exceptionGuides.forEach((guide, guideIndex) => {
      assert.notStrictEqual(guide, expected.exceptionGuides[guideIndex]);
      assert.ok(guide.check.length > 0);
      assert.ok(guide.action.length > 0);
    });
  });
});

test("중복 예외 항목과 반복 호출의 가이드 배열 및 객체는 독립적이다", () => {
  const orders = Object.freeze([exceptionOrder, exceptionOrder, Object.freeze({ ...exceptionOrder })]);
  const snapshot = orders.map((order) => ({ ...order }));
  const first = analyzeOrderBatch(orders);
  const second = analyzeOrderBatch(orders);
  const results = [...first.results, ...second.results];
  results.forEach((result, index) => {
    assert.deepEqual(result.exceptionGuides, analyzeOrder(exceptionOrder).exceptionGuides);
    for (const other of results.slice(index + 1)) {
      assert.notStrictEqual(result.exceptionGuides, other.exceptionGuides);
    }
  });
  const guides = results.flatMap(({ exceptionGuides }) => exceptionGuides);
  guides.forEach((guide, index) => {
    for (const other of guides.slice(index + 1)) assert.notStrictEqual(guide, other);
  });
  first.results[0]!.exceptionGuides.forEach((guide) => {
    guide.reasonCode = "INVALID_QUANTITY";
    guide.check = "변경";
    guide.action = "변경";
  });
  first.results[0]!.exceptionGuides.length = 0;
  for (const result of results.slice(1)) {
    assert.deepEqual(result.exceptionGuides, analyzeOrder(exceptionOrder).exceptionGuides);
  }
  assert.deepEqual(first.results[0]!.reasonCodes, reasonCodeOrder);
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.exceptionPriorities, second.exceptionPriorities);
  assert.deepEqual(analyzeOrderBatch(orders), second);
  assert.deepEqual(orders, snapshot);
});

test("중복 정상 항목과 반복 호출의 빈 가이드 배열도 독립적이다", () => {
  const orders = [normalOrder, normalOrder];
  const first = analyzeOrderBatch(orders);
  const second = analyzeOrderBatch(orders);
  const results = [...first.results, ...second.results];
  results.forEach((result, index) => {
    assert.deepEqual(result.exceptionGuides, []);
    for (const other of results.slice(index + 1)) {
      assert.notStrictEqual(result.exceptionGuides, other.exceptionGuides);
    }
  });
  first.results[0]!.exceptionGuides.push({
    reasonCode: "CUSTOMER_BLOCKED", check: "변경", action: "변경",
  });
  for (const result of results.slice(1)) assert.deepEqual(result.exceptionGuides, []);
  assert.deepEqual(analyzeOrderBatch(orders), second);
});

test("처리 목록은 완성된 우선순위와 일치하며 중복 ID와 동일 객체의 복수 사유를 보존한다", () => {
  const shared = Object.freeze({ ...exceptionOrder, dueDate: "2026-10-16", estimatedAmount: 10, orderComment: "반복 주문" });
  const orders = Object.freeze([
    shared,
    Object.freeze({ ...normalOrder, orderId: shared.orderId, dueDate: "0001-01-01" }),
    Object.freeze({ ...shared, customerId: "C-002", materialId: "M-002", dueDate: "2026-10-15", estimatedAmount: 0, orderComment: "" }),
    shared,
    Object.freeze({ ...shared, estimatedAmount: 20 }),
    exceptionOrder,
  ]);
  const snapshot = orders.map((order) => ({ ...order }));
  const batch = analyzeOrderBatch(orders);
  assert.deepEqual(batch.exceptionWorklist.map(({ rank, resultIndex }) => ({ rank, resultIndex })), [
    { rank: 1, resultIndex: 2 },
    { rank: 2, resultIndex: 4 },
    { rank: 3, resultIndex: 0 },
    { rank: 4, resultIndex: 3 },
    { rank: 5, resultIndex: 5 },
  ]);
  assert.equal(batch.exceptionWorklist.length, batch.summary.exceptionCount);
  assert.deepEqual(batch.exceptionWorklist, batch.exceptionPriorities.map(({ rank, resultIndex }) => {
    const result = batch.results[resultIndex]!;
    assert.equal(result.status, "EXCEPTION");
    return { rank, resultIndex, orderId: result.orderId, orderDetails: result.orderDetails, reasonCodes: result.reasonCodes, exceptionGuides: result.exceptionGuides };
  }));
  for (const item of batch.exceptionWorklist) {
    assert.deepEqual(Object.keys(item).sort(), ["exceptionGuides", "orderDetails", "orderId", "rank", "reasonCodes", "resultIndex"]);
    assert.deepEqual(item.reasonCodes, reasonCodeOrder);
    assert.deepEqual(item.exceptionGuides, analyzeOrder(orders[item.resultIndex]!).exceptionGuides);
    for (const key of ["estimatedAmount", "dueDate", "orderComment"] as const) {
      assert.equal(Object.prototype.hasOwnProperty.call(item.orderDetails, key), item.resultIndex !== 5);
    }
  }
  assert.deepEqual(batch.exceptionWorklist[0]!.orderDetails, {
    materialId: "M-002", orderQuantity: 0, customerId: "C-002",
    estimatedAmount: 0, dueDate: "2026-10-15", orderComment: "",
  });
  assert.deepEqual(batch.results.map(({ orderId }) => orderId), orders.map(({ orderId }) => orderId));
  assert.deepEqual(analyzeOrderBatch(orders), batch);
  assert.equal(JSON.stringify(analyzeOrderBatch(orders)), JSON.stringify(batch));
  assert.deepEqual(orders, snapshot);
});

test("처리 목록은 선택 상세 필드의 생략과 원래 값을 보존한다", () => {
  const variants: Partial<OrderInput>[] = [
    {}, { estimatedAmount: 0 }, { dueDate: "미정" }, { orderComment: "" },
    { estimatedAmount: -1, dueDate: "2026-02-30", orderComment: "  확인\n요청  " },
  ];
  for (const details of variants) {
    const batch = analyzeOrderBatch([{ ...exceptionOrder, ...details }]);
    const item = batch.exceptionWorklist[0]!;
    assert.deepEqual(item.orderDetails, {
      materialId: exceptionOrder.materialId,
      orderQuantity: exceptionOrder.orderQuantity,
      customerId: exceptionOrder.customerId,
      ...details,
    });
    for (const key of ["estimatedAmount", "dueDate", "orderComment"] as const) {
      assert.equal(Object.prototype.hasOwnProperty.call(item.orderDetails, key), Object.prototype.hasOwnProperty.call(details, key));
    }
  }
});

test("처리 목록의 상세, 사유, 가이드 사본은 결과와 다른 항목 및 호출에서 독립적이다", () => {
  const shared = Object.freeze({ ...exceptionOrder, dueDate: "2026-10-15", estimatedAmount: 100, orderComment: "확인" });
  const orders = Object.freeze([shared, shared, Object.freeze({ ...shared })]);
  const inputSnapshot = orders.map((order) => ({ ...order }));
  const first = analyzeOrderBatch(orders);
  const second = analyzeOrderBatch(orders);
  const secondSnapshot = JSON.stringify(second);
  assert.notStrictEqual(first.exceptionWorklist, second.exceptionWorklist);
  const items = [...first.exceptionWorklist, ...second.exceptionWorklist];
  const copies = [...items, ...first.results, ...second.results];
  copies.forEach((item, index) => {
    for (const order of orders) assert.notStrictEqual(item.orderDetails, order);
    for (const other of copies.slice(index + 1)) {
      assert.notStrictEqual(item, other);
      assert.notStrictEqual(item.orderDetails, other.orderDetails);
      assert.notStrictEqual(item.reasonCodes, other.reasonCodes);
      assert.notStrictEqual(item.exceptionGuides, other.exceptionGuides);
      for (const guide of item.exceptionGuides) {
        for (const otherGuide of other.exceptionGuides) assert.notStrictEqual(guide, otherGuide);
      }
    }
  });
  const changed = first.exceptionWorklist[0]!;
  Object.assign(changed.orderDetails, {
    materialId: "CHANGED", orderQuantity: 99, customerId: "CHANGED",
    estimatedAmount: 0, dueDate: "미정", orderComment: "변경",
  });
  changed.reasonCodes.reverse();
  changed.exceptionGuides[0]!.reasonCode = "CUSTOMER_BLOCKED";
  changed.exceptionGuides[0]!.check = "변경";
  changed.exceptionGuides[0]!.action = "변경";
  changed.exceptionGuides.reverse();
  changed.rank = 99;
  changed.resultIndex = 99;
  changed.orderId = "CHANGED";
  assert.deepEqual(first.results, second.results);
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.exceptionPriorities, second.exceptionPriorities);
  assert.deepEqual(first.exceptionWorklist.slice(1), second.exceptionWorklist.slice(1));
  assert.equal(JSON.stringify(second), secondSnapshot);
  assert.deepEqual(orders, inputSnapshot);
  first.exceptionWorklist.reverse();
  first.exceptionWorklist.length = 0;
  assert.deepEqual(analyzeOrderBatch(orders), second);
  const preserved = JSON.stringify(second.exceptionWorklist);
  second.results[0]!.orderDetails.orderComment = "결과 변경";
  second.results[0]!.reasonCodes.length = 0;
  second.results[0]!.exceptionGuides[0]!.check = "결과 변경";
  second.results[0]!.exceptionGuides.length = 0;
  second.exceptionPriorities[0]!.rank = 99;
  assert.equal(JSON.stringify(second.exceptionWorklist), preserved);
});

test("빈 입력과 정상 입력은 독립적인 빈 처리 목록을 반환한다", () => {
  const batches = [analyzeOrderBatch([]), analyzeOrderBatch([]), analyzeOrderBatch([normalOrder, normalOrder]), analyzeOrderBatch([normalOrder])];
  batches.forEach((batch, index) => {
    assert.deepEqual(batch.exceptionWorklist, []);
    for (const other of batches.slice(index + 1)) assert.notStrictEqual(batch.exceptionWorklist, other.exceptionWorklist);
  });
  batches[0]!.exceptionWorklist.push(analyzeOrderBatch([exceptionOrder]).exceptionWorklist[0]!);
  for (const batch of batches.slice(1)) assert.deepEqual(batch.exceptionWorklist, []);
  assert.deepEqual(analyzeOrderBatch([]).exceptionWorklist, []);
  assert.deepEqual(analyzeOrderBatch([normalOrder]).exceptionWorklist, []);
});
