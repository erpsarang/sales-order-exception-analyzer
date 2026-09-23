import assert from "node:assert/strict";
import test from "node:test";
import { analyzeOrder } from "../src/order-analysis.js";
import { createDecisionContextProvider, enrichOrder, type DecisionContextProvider } from "../src/decision-context.js";
import { localDecisionContextProvider, localDecisionReference } from "../src/local-decision-reference.js";

const order = Object.freeze({ orderId: "SO-1", customerId: "C-1", materialId: "M-1", orderQuantity: 15, estimatedAmount: 100, dueDate: "2026-10-15", orderComment: "확인" });

test("동일 스냅샷으로 반복 보강하며 주문과 기준을 변경하거나 재고를 차감하지 않는다", () => {
  const before = JSON.stringify(localDecisionReference);
  const first = enrichOrder(order, localDecisionContextProvider);
  assert.notEqual(first, order);
  assert.deepEqual(first, { ...order, availableQuantity: 20, customerBlocked: false, materialBlocked: false });
  first.availableQuantity = 0;
  const second = enrichOrder(order, localDecisionContextProvider);
  assert.equal(second.availableQuantity, 20);
  assert.deepEqual(enrichOrder(order, localDecisionContextProvider), second);
  assert.equal("availableQuantity" in order, false);
  assert.equal(JSON.stringify(localDecisionReference), before);
  assert.equal(analyzeOrder(second).status, "SHIP_READY");
});

test("정확한 식별자로 조회하고 미등록 고객·자재·재고를 구분한다", () => {
  const missingCustomer = createDecisionContextProvider({ ...localDecisionReference, customers: [] });
  const missingMaterial = createDecisionContextProvider({ ...localDecisionReference, materials: [] });
  const missingInventory = createDecisionContextProvider({ ...localDecisionReference, inventory: [] });
  for (const [provider, kind, id] of [
    [missingCustomer, "고객", "C-1"],
    [missingMaterial, "자재", "M-1"],
    [missingInventory, "재고", "M-1"],
  ] as const) {
    assert.throws(() => enrichOrder(order, provider), new RegExp(`SO-1.*${kind}.*${id}.*데이터가 없습니다`));
  }
  for (const customerId of ["c-1", " C-1", "C-1 ", "toString"]) {
    assert.throws(() => enrichOrder({ ...order, customerId }, localDecisionContextProvider), /SO-1.*고객.*데이터가 없습니다/);
  }
  for (const materialId of ["m-1", " M-1", "M-1 "]) {
    assert.throws(() => enrichOrder({ ...order, materialId }, localDecisionContextProvider), /SO-1.*자재.*데이터가 없습니다/);
  }
});

test("누락 검사 순서는 고객, 자재, 재고로 고정된다", () => {
  const calls: string[] = [];
  const provider: DecisionContextProvider = {
    getCustomerBlocked: () => { calls.push("고객"); return undefined; },
    getMaterialBlocked: () => { calls.push("자재"); return undefined; },
    getAvailableQuantity: () => { calls.push("재고"); return undefined; },
  };
  assert.throws(() => enrichOrder(order, provider), /고객/);
  assert.deepEqual(calls, ["고객"]);
  calls.length = 0;
  assert.throws(() => enrichOrder(order, { ...provider, getCustomerBlocked: () => { calls.push("고객"); return false; } }), /자재/);
  assert.deepEqual(calls, ["고객", "자재"]);
  calls.length = 0;
  enrichOrder(order, {
    getCustomerBlocked: () => { calls.push("고객"); return false; },
    getMaterialBlocked: () => { calls.push("자재"); return false; },
    getAvailableQuantity: () => { calls.push("재고"); return 20; },
  });
  assert.deepEqual(calls, ["고객", "자재", "재고"]);
});

test("기준 값은 변환이나 기본값 없이 검증한다", () => {
  for (const value of [null, "false", 0, {}, undefined]) {
    assert.throws(() => enrichOrder(order, { ...localDecisionContextProvider, getCustomerBlocked: () => value }), /SO-1.*고객.*C-1/);
    assert.throws(() => enrichOrder(order, { ...localDecisionContextProvider, getMaterialBlocked: () => value }), /SO-1.*자재.*M-1/);
  }
  for (const value of [null, "20", false, NaN, Infinity, -Infinity, undefined]) {
    assert.throws(() => enrichOrder(order, { ...localDecisionContextProvider, getAvailableQuantity: () => value }), /SO-1.*재고.*M-1/);
  }
});

test("기존 Analyzer의 전체 사유 순서와 안내를 보존한다", () => {
  const provider: DecisionContextProvider = {
    getCustomerBlocked: () => true,
    getMaterialBlocked: () => true,
    getAvailableQuantity: () => -1,
  };
  const business = { ...order, orderQuantity: 0 };
  const actual = analyzeOrder(enrichOrder(business, provider));
  assert.deepEqual(actual.reasonCodes, ["INVALID_QUANTITY", "CUSTOMER_BLOCKED", "MATERIAL_BLOCKED", "INSUFFICIENT_STOCK"]);
  assert.deepEqual(actual, analyzeOrder({ ...business, availableQuantity: -1, customerBlocked: true, materialBlocked: true }));
});
