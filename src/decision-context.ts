import type { OrderInput } from "./order-analysis.js";

export type BusinessOrder = Omit<OrderInput, "availableQuantity" | "customerBlocked" | "materialBlocked">;

/** 조회 결과는 보강 경계에서 런타임 검증한다. undefined는 미등록을 뜻한다. */
export interface DecisionContextProvider {
  getCustomerBlocked(customerId: string): unknown;
  getMaterialBlocked(materialId: string): unknown;
  getAvailableQuantity(materialId: string): unknown;
}

export interface DecisionReference {
  readonly customers: readonly Readonly<{ customerId: string; customerBlocked: boolean }>[];
  readonly materials: readonly Readonly<{ materialId: string; materialBlocked: boolean }>[];
  readonly inventory: readonly Readonly<{ materialId: string; availableQuantity: number }>[];
}

/** 식별자를 정규화하지 않고 정확히 일치하는 기준을 조회한다. */
export function createDecisionContextProvider(reference: DecisionReference): DecisionContextProvider {
  return {
    getCustomerBlocked: (id) => reference.customers.find((row) => row.customerId === id)?.customerBlocked,
    getMaterialBlocked: (id) => reference.materials.find((row) => row.materialId === id)?.materialBlocked,
    getAvailableQuantity: (id) => reference.inventory.find((row) => row.materialId === id)?.availableQuantity,
  };
}

/** 고객, 자재, 재고 순으로 검사하며 주문과 기준 데이터를 변경하지 않는다. */
export function enrichOrder(order: Readonly<BusinessOrder>, provider: DecisionContextProvider): OrderInput {
  function invalid(kind: string, id: string, value: unknown, expected: string): never {
    throw new Error(`주문 ${JSON.stringify(order.orderId)}: ${kind} 기준 ${JSON.stringify(id)} ${value === undefined ? "데이터가 없습니다." : `${expected}이어야 합니다.`}`);
  }
  const customerBlocked = provider.getCustomerBlocked(order.customerId);
  if (typeof customerBlocked !== "boolean") invalid("고객", order.customerId, customerBlocked, "customerBlocked는 true 또는 false");
  const materialBlocked = provider.getMaterialBlocked(order.materialId);
  if (typeof materialBlocked !== "boolean") invalid("자재", order.materialId, materialBlocked, "materialBlocked는 true 또는 false");
  const availableQuantity = provider.getAvailableQuantity(order.materialId);
  if (typeof availableQuantity !== "number" || !Number.isFinite(availableQuantity)) invalid("재고", order.materialId, availableQuantity, "availableQuantity는 유한한 숫자");
  return { ...order, availableQuantity, customerBlocked, materialBlocked };
}
