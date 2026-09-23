import { createDecisionContextProvider, type DecisionReference } from "./decision-context.js";

/** 운영 데이터가 아닌 재현 가능한 로컬 예제 스냅샷. 주문마다 같은 재고를 적용한다. */
export const localDecisionReference: DecisionReference = Object.freeze({
  customers: Object.freeze([
    Object.freeze({ customerId: "C-1", customerBlocked: false }),
    Object.freeze({ customerId: "C-2", customerBlocked: true }),
  ]),
  materials: Object.freeze([
    Object.freeze({ materialId: "M-1", materialBlocked: false }),
    Object.freeze({ materialId: "M-2", materialBlocked: true }),
  ]),
  inventory: Object.freeze([
    Object.freeze({ materialId: "M-1", availableQuantity: 20 }),
    Object.freeze({ materialId: "M-2", availableQuantity: 0 }),
  ]),
});

export const localDecisionContextProvider = createDecisionContextProvider(localDecisionReference);
