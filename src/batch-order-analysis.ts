import { analyzeOrder, type OrderAnalysisResult, type OrderInput } from "./order-analysis.js";

type ReasonCode = OrderAnalysisResult["reasonCodes"][number];

const reasonCodeOrder: readonly ReasonCode[] = [
  "INVALID_QUANTITY",
  "CUSTOMER_BLOCKED",
  "MATERIAL_BLOCKED",
  "INSUFFICIENT_STOCK",
];

export interface BatchOrderResult extends OrderAnalysisResult {
  orderId: string;
}

export interface BatchOrderAnalysisResult {
  results: BatchOrderResult[];
  summary: {
    totalCount: number;
    shipReadyCount: number;
    exceptionCount: number;
    exceptionRate: number;
    reasonCounts: Record<ReasonCode, number>;
    topReasonCodes: ReasonCode[];
  };
}

/** 입력 순서대로 기존 주문 판정을 수행하며 입력을 변경하지 않는다. */
export function analyzeOrderBatch(
  orders: ReadonlyArray<Readonly<OrderInput>>,
): BatchOrderAnalysisResult {
  let shipReadyCount = 0;
  let exceptionCount = 0;
  const reasonCounts: Record<ReasonCode, number> = {
    INVALID_QUANTITY: 0,
    CUSTOMER_BLOCKED: 0,
    MATERIAL_BLOCKED: 0,
    INSUFFICIENT_STOCK: 0,
  };
  const results = orders.map((order) => {
    const analysis = analyzeOrder(order);
    if (analysis.status === "SHIP_READY") shipReadyCount += 1;
    else {
      exceptionCount += 1;
      for (const reasonCode of analysis.reasonCodes) {
        reasonCounts[reasonCode] += 1;
      }
    }
    return { orderId: order.orderId, ...analysis };
  });
  const maxReasonCount = Math.max(...reasonCodeOrder.map((code) => reasonCounts[code]));
  const topReasonCodes = maxReasonCount === 0
    ? []
    : reasonCodeOrder.filter((code) => reasonCounts[code] === maxReasonCount);

  return {
    results,
    summary: {
      totalCount: results.length,
      shipReadyCount,
      exceptionCount,
      exceptionRate: results.length === 0 ? 0 : exceptionCount / results.length,
      reasonCounts,
      topReasonCodes,
    },
  };
}
