export interface OrderInput {
  orderId: string;
  customerId: string;
  materialId: string;
  orderQuantity: number;
  availableQuantity: number;
  customerBlocked: boolean;
  materialBlocked: boolean;
  /** 예상 금액은 입력 측 단위의 숫자로 표현하며 계산하거나 통화 환산하지 않는다. */
  estimatedAmount?: number;
  /** 납기일은 시간대 없는 YYYY-MM-DD 문자열로 표현한다. */
  dueDate?: string;
  /** 주문 코멘트는 일반 텍스트로 표현한다. */
  orderComment?: string;
}

export type ReasonCode =
  | "INVALID_QUANTITY"
  | "CUSTOMER_BLOCKED"
  | "MATERIAL_BLOCKED"
  | "INSUFFICIENT_STOCK";

export interface OrderAnalysisResult {
  status: "SHIP_READY" | "EXCEPTION";
  reasonCodes: ReasonCode[];
}

/** 모든 해당 예외를 정해진 순서로 반환하며 입력을 변경하지 않는다. */
export function analyzeOrder(order: Readonly<OrderInput>): OrderAnalysisResult {
  const reasonCodes: ReasonCode[] = [];

  if (order.orderQuantity <= 0) reasonCodes.push("INVALID_QUANTITY");
  if (order.customerBlocked) reasonCodes.push("CUSTOMER_BLOCKED");
  if (order.materialBlocked) reasonCodes.push("MATERIAL_BLOCKED");
  if (order.availableQuantity < order.orderQuantity)
    reasonCodes.push("INSUFFICIENT_STOCK");

  return {
    status: reasonCodes.length === 0 ? "SHIP_READY" : "EXCEPTION",
    reasonCodes,
  };
}
