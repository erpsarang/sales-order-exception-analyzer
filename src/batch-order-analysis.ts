import { analyzeOrder, type OrderAnalysisResult, type OrderInput } from "./order-analysis.js";

export interface BatchOrderResult extends OrderAnalysisResult {
  orderId: string;
}

export interface BatchOrderAnalysisResult {
  results: BatchOrderResult[];
  summary: {
    totalCount: number;
    shipReadyCount: number;
    exceptionCount: number;
  };
}

/** 입력 순서대로 기존 주문 판정을 수행하며 입력을 변경하지 않는다. */
export function analyzeOrderBatch(
  orders: ReadonlyArray<Readonly<OrderInput>>,
): BatchOrderAnalysisResult {
  let shipReadyCount = 0;
  let exceptionCount = 0;
  const results = orders.map((order) => {
    const analysis = analyzeOrder(order);
    if (analysis.status === "SHIP_READY") shipReadyCount += 1;
    else exceptionCount += 1;
    return { orderId: order.orderId, ...analysis };
  });

  return {
    results,
    summary: { totalCount: results.length, shipReadyCount, exceptionCount },
  };
}
